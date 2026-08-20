/**
 * File: pages/api/observations.ts
 * POST { jobCardId, key, customerResponse } — one tapped observation becomes one finding.
 *
 * OPERATIONAL authority: the person at the car.
 *
 * ── NO CLIENT-SUPPLIED id, AND THE REASON IS NOW A PATTERN ──────────────────────────────────────
 * Three capture shapes, three answers to the same question, and they differ because the DATA
 * differs — not because three people made three choices:
 *
 *   tyre readings   natural key (job_card_id, corner)      → replay upserts
 *   battery test    natural key (job_card_id)              → replay upserts
 *   observation     natural key (group, vehicle, key) while open, enforced by a partial unique
 *                   index → a replay finds the existing row and reports success
 *   free-text find  NO natural key at all                  → needs a client-supplied id
 *
 * So a phone that loses signal mid-request and redelivers cannot give a garage two "wiper blades
 * smearing" findings on one car. Do not "simplify" that partial unique index away; it is what makes
 * the replay safe, exactly as (card, corner) is for tyres.
 *
 * ── THE RESPONSE IS NEVER DEFAULTED ─────────────────────────────────────────────────────────────
 * This endpoint refuses without one. The whole point of the tap-list is speed, and this is the one
 * place it is allowed to cost a tap: a silent `not_raised` on every finding would mean `declined`
 * — the only response that is a lead — never appears at all.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { refuseBayWrite, bayWriteCard, BAY_WRITE_SELECT } from '@/lib/bay-write';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { observationByKey } from '@/lib/observations';

const RESPONSES = ['not_raised', 'declined', 'agreed_later'] as const;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const { jobCardId, key, customerResponse } = (req.body || {}) as { jobCardId?: string; key?: string; customerResponse?: string };
  if (!jobCardId) return res.status(400).json({ message: 'A job card is required.' });

  const obs = key ? observationByKey(String(key)) : null;
  if (!obs) return res.status(400).json({ message: 'Unknown observation.' });
  // No check for a "group parent" here, deliberately: "Bulb out" is a LABEL on the disclosure
  // control (lib/observations::BULB_GROUP_LABEL), not a catalogue entry, so there is no key that
  // could resolve to one. A guard against it would be a claim the code cannot make true or false.
  if (!customerResponse || !RESPONSES.includes(customerResponse as never)) {
    return res.status(400).json({ message: 'Say whether it was raised with the customer.' });
  }

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: { id: true, site_id: true, vehicle_id: true, ...BAY_WRITE_SELECT },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  // ── A FINISHED JOB TAKES NO NEW BAY DATA ────────────────────────────────────────────────────
  // One predicate, seven writers. See lib/bay-write: the invoice freeze is the boundary and the
  // admin unlock is the way back, because both already exist and both are already audited.
  const bayRefusal = refuseBayWrite(bayWriteCard(card as never));
  if (bayRefusal) return res.status(409).json({ message: bayRefusal.message, code: bayRefusal.code });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const row = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // The natural key doing its job. An open item for this observation on this car already exists →
    // the caller's intent is already true, so report success rather than stacking a duplicate or
    // failing the constraint. A REPLAY must never look like an error: the outbox would retry forever.
    const existing = await tx.vehicleDueItem.findFirst({
      where: { group_id: groupId, vehicle_id: card.vehicle_id, closed_at: null, observation_key: obs.key },
      select: { id: true },
    });
    if (existing) return { id: existing.id, replayed: true as const };

    const created = await tx.vehicleDueItem.create({
      data: {
        group_id: groupId, vehicle_id: card.vehicle_id, found_on_job_card_id: card.id,
        observation_key: obs.key,
        description: obs.description,
        // AUTHORED in lib/observations, per entry — not a default applied here. If this line ever
        // starts choosing a basis, the distinction has been lost.
        due_basis: obs.basis,
        // Authored in the catalogue beside the description, never inferred from it.
        timing_in_description: obs.carriesOwnTiming,
        customer_response: customerResponse as never,
        response_at: customerResponse === 'not_raised' ? null : new Date(),
        created_by: user.id as string,
      },
      select: { id: true },
    });
    await writeAudit(tx, {
      groupId, userId: user.id as string, jobCardId: card.id,
      action: 'due_item.found',
      diff: { observationKey: obs.key, description: obs.description, dueBasis: obs.basis, customerResponse, via: 'tap' },
    });
    return { id: created.id, replayed: false as const };
  });

  return res.status(200).json({ ok: true, ...row });
}
