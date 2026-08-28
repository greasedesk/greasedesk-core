/**
 * File: pages/api/marketing-contact.ts
 * POST { vehicleId, reason, state, forDate } — what the garage did about a car that is due.
 *
 * NOTHING HERE SENDS. The garage rings, texts or emails through the surfaces that already exist;
 * this only records that they did, so the badge can fall.
 *
 * ── `booked` TRUSTS THE TAP ─────────────────────────────────────────────────────────────────────
 * It does not check that a Booking exists. Verifying is right eventually and is a second thing to
 * get wrong today. The consequence, stated rather than hidden: a car marked booked that never was
 * disappears from the list until its `for_date` passes, and then comes back — which is the same
 * self-correction that spends every other contact record.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { writeAudit } from '@/lib/audit';
import { SNOOZE_DAYS } from '@/lib/marketing-lists';
import { LEAD_REASON_KINDS } from '@/lib/marketing-pipeline';

const STATES = ['contacted', 'booked', 'declined', 'snoozed'] as const;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const { vehicleId, reason, state, forDate } = (req.body || {}) as
    { vehicleId?: string; reason?: string; state?: string; forDate?: string | null };
  if (!vehicleId) return res.status(400).json({ message: 'A vehicle is required.' });
  // WHAT THE CALL WAS ABOUT, in the board's own vocabulary. This used to check a two-value enum of
  // LIST NAMES — and the board, being one list, sent 'mot' for every car including the ones rung
  // about a failed battery. LEAD_REASON_KINDS is the set the pipeline actually produces.
  if (!LEAD_REASON_KINDS.includes(reason as never)) return res.status(400).json({ message: 'Unknown reason.' });
  if (!STATES.includes(state as never)) return res.status(400).json({ message: 'Unknown outcome.' });

  // TENANT SCOPE, from the row rather than the caller. A vehicle id is guessable and this endpoint
  // would otherwise let one garage record contacts against another's car.
  const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, group_id: groupId }, select: { id: true } });
  if (!vehicle) return res.status(404).json({ message: 'Vehicle not found.' });

  // A TRIGGER-BAND CAR HAS NO DATE, so the record needs one anyway to be spendable. A month out is
  // the same horizon as the list itself: contacted about a car with no clock, ask again next month.
  const at = new Date();
  // ── THE TENANT'S SNOOZE, OR THE PLATFORM'S ───────────────────────────────────────────────────
  // Group.marketing_snooze_days is NULLABLE and null means NEVER SET, not zero — so SNOOZE_DAYS
  // stays the fallback rather than being copied into every tenant at migration time, which would
  // make a deliberate choice of 30 and nobody-having-been-asked identical for ever. Resolved once,
  // used by both reads below, so the "ask again" date and the snooze cannot come from different
  // numbers on the same request.
  const g = await prisma.group.findUnique({ where: { id: groupId }, select: { marketing_snooze_days: true } });
  const snoozeDays = g?.marketing_snooze_days ?? SNOOZE_DAYS;
  const forAt = forDate ? new Date(`${forDate}T00:00:00.000Z`) : new Date(at.getTime() + snoozeDays * 86_400_000);
  if (Number.isNaN(forAt.getTime())) return res.status(400).json({ message: 'That date does not look right.' });
  // A snooze with no end is a hide — so the SERVER sets it and the client cannot omit it.
  const snoozeUntil = state === 'snoozed' ? new Date(at.getTime() + snoozeDays * 86_400_000) : null;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.marketingContact.upsert({
      // ONE ANSWER PER CAR. Keyed on the car alone: a garage makes one phone call, and keying on
      // the reason too would let the same call leave a car contacted for one thing and not for
      // another. `reason` is UPDATED as well as created — the latest call is what it was about.
      where: { group_id_vehicle_id: { group_id: groupId, vehicle_id: vehicleId } },
      create: {
        group_id: groupId, vehicle_id: vehicleId, reason: reason as never, state: state as never,
        for_date: forAt, snooze_until: snoozeUntil, actor_id: user.id as string,
      },
      update: { state: state as never, reason: reason as never, for_date: forAt, snooze_until: snoozeUntil, actor_id: user.id as string },
    });
    // The HISTORY lives here, which is where history lives. The table above answers one question:
    // what is outstanding right now.
    await writeAudit(tx, {
      groupId, userId: user.id as string,
      entity: 'vehicle', entityId: vehicleId,
      action: 'marketing.contact_recorded',
      diff: { reason, state, forDate: forAt.toISOString().slice(0, 10), snoozeUntil: snoozeUntil?.toISOString().slice(0, 10) ?? null },
    });
  });

  return res.status(200).json({ ok: true, state, snoozeUntil: snoozeUntil?.toISOString().slice(0, 10) ?? null });
}
