/**
 * File: pages/api/intake-items.ts
 * The two things a mechanic can do to an intake prompt that are not capturing the artefact itself.
 *
 *   POST { jobCardId, action: 'nothing_found' }                  → the affirmative
 *   POST { jobCardId, action: 'skip', item, reason? }            → an audited skip
 *
 * OPERATIONAL authority: this is the person at the car.
 *
 * Neither action BLOCKS anything — there is nothing here that can refuse to let a job proceed. The
 * only consequence of a skip is that the escalation names it, which is the whole design.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { INTAKE_ITEMS, type IntakeItem } from '@/lib/intake-items';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const { jobCardId, action, item, reason } = (req.body || {}) as
    { jobCardId?: string; action?: 'nothing_found' | 'skip' | 'undo_nothing_found'; item?: IntakeItem; reason?: string };
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: { id: true, site_id: true, intake_nothing_found_at: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  // ── THE AFFIRMATIVE ─────────────────────────────────────────────────────────────────────────────
  // ONE TAP. It is the difference between an escalation that gets read and one that gets filtered:
  // a clean car must be able to satisfy the findings prompt without a skip, or every properly-done
  // clean car generates a false alarm.
  if (action === 'nothing_found') {
    if (card.intake_nothing_found_at) return res.status(200).json({ ok: true, at: card.intake_nothing_found_at }); // idempotent
    const at = new Date();
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCard.update({ where: { id: jobCardId }, data: { intake_nothing_found_at: at, intake_nothing_found_by: user.id as string } });
      await writeAudit(tx, { groupId, userId: user.id as string, jobCardId, action: 'intake.nothing_found' });
    });
    return res.status(200).json({ ok: true, at });
  }

  // Undo, for the mis-tap. The audit keeps both events; only the current state changes.
  if (action === 'undo_nothing_found') {
    if (!card.intake_nothing_found_at) return res.status(200).json({ ok: true });
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCard.update({ where: { id: jobCardId }, data: { intake_nothing_found_at: null, intake_nothing_found_by: null } });
      await writeAudit(tx, { groupId, userId: user.id as string, jobCardId, action: 'intake.nothing_found_cleared' });
    });
    return res.status(200).json({ ok: true });
  }

  // ── A SKIP ──────────────────────────────────────────────────────────────────────────────────────
  // An AUDIT EVENT, not a column: a skip has an actor, a time and a reason, which is what the audit
  // log is for — and it must not outlive the gap, because doing the thing afterwards makes the item
  // done (lib/intake-items derives `skipped` against `done`). A column would have to be cleared by
  // every path that could satisfy the item, including the phone's upload API.
  if (action === 'skip') {
    if (!item || !(INTAKE_ITEMS as readonly string[]).includes(item)) {
      return res.status(400).json({ message: 'A valid item is required.' });
    }
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await writeAudit(tx, {
        groupId, userId: user.id as string, jobCardId,
        action: 'intake.item_skipped',
        diff: { item, reason: (reason ?? '').trim().slice(0, 300) || null },
      });
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ message: 'Unknown action.' });
}
