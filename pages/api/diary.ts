/**
 * File: pages/api/diary.ts
 * Place / move / unplace a JobCard on a Resource over a continuous time interval.
 * start_at / end_at are the scheduling source of truth (half-open interval [start, end)).
 * Tenant-scoped to the caller's group; a card may only be placed on a Resource of its OWN site.
 *
 *   PATCH  { jobCardId, resourceId, startAt, workingMinutes }  → move
 *   DELETE { jobCardId }                                        → unplace
 *
 * ── THIS ROUTE IS A MOVE, ALWAYS (2026-10-01) ───────────────────────────────────────────────────
 * Both of its callers — the diary's drag and Reschedule dialog, and the card page's Booking block —
 * change the slot of a card that already exists without touching its status. So it declares
 * `act: 'move'` to placeJobCard, which refuses a slot that has become a RECORD (invoiced, paid,
 * done, cancelled, declined, no-show) and refuses a start that is not a working moment.
 *
 * The act is NOT taken from the request body. A guard a client can downgrade by sending a
 * different word is not a guard. The one legitimate way to re-book a declined card is to reopen it
 * — /api/jobcard-accept, which declares 'book' because it decides the status in the same breath.
 *
 * HARD RULE: never silently overwrite. Placement runs an interval-overlap guard inside a
 * transaction and REFUSES (409) if [startAt, endAt) overlaps any other card on the same
 * resource. Back-to-back bookings (end == next start) do NOT clash (half-open).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { placeJobCard } from '@/lib/diary-booking';
import { reBookingDoor } from '@/lib/jobcard-status';
import { writeAudit } from '@/lib/audit';

function parseDateTime(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) {
    return res.status(401).json({ message: 'Authentication Error: Group/Site context not found.' });
  }
  const vis = await getVisibility(user.id as string); // visible sites

  // MODULE GATE (slice-1 C): placing/moving a card on a resource IS the Booking capability. Refused
  // NO MODULE GATE HERE (ruling 2026-07-29). Moving/removing a job in the garage's OWN diary is
  // Core and always was — this route was gated on a `booking` module from the retired three-tier
  // ladder, which blocked every tenant whose subscription touched the cache writer. The paid
  // module is CUSTOMER-FACING online booking; when that is built it gets a gate on the route that
  // implements it. lib/modules stays intact and in use — it is simply not this route's concern.

  if (req.method === 'PATCH') {
    const { jobCardId, resourceId, startAt, workingMinutes } = (req.body || {}) as {
      jobCardId?: string; resourceId?: string; startAt?: string; workingMinutes?: number;
    };
    if (!jobCardId || !resourceId) {
      return res.status(400).json({ message: 'jobCardId and resourceId are required.' });
    }
    const start = parseDateTime(startAt);
    if (!start) return res.status(400).json({ message: 'startAt must be a valid datetime.' });
    // DURATION IS THE ONLY THING THIS ROUTE ACCEPTS. An end time cannot say how long a job is:
    // (end − start) counts a lunch break and the hours the garage is shut as work, so a 09:00–17:00
    // booking at a site that closes for lunch becomes eight WORKING hours and runs to 18:00.
    //
    // The endAt bridge that used to sit here is gone. It existed for the card page's old booking
    // block (components/jobcard/JobCardBooking), which has had no callers since the six-tab
    // workspace replaced it — and the workspace sends workingMinutes. A bridge for a caller that
    // no longer exists is a door nothing uses and the next form might.
    if (!(typeof workingMinutes === 'number' && workingMinutes > 0)) {
      return res.status(400).json({ message: 'A valid duration is required. Send workingMinutes — an end time cannot say how long a job is.' });
    }

    let from: { resourceId: string | null; startAt: string | null; workingMinutes: number | null } | null = null;
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Scheduling = resource allocation = commercial: manager/admin only (one rule for diary + card).
        const card = await tx.jobCard.findFirst({ where: { id: jobCardId, site_id: { in: vis.siteIds } }, select: { site_id: true } });
        if (!card) throw new Error('CARD_NOT_FOUND');
        if (!canManageSite(vis, card.site_id)) throw new Error('FORBIDDEN');
        // Shared guard (scope + status + working-moment + footprint-overlap + update) — the one
        // place placement happens. It returns BOTH positions, read inside this transaction.
        const moved = await placeJobCard(tx, { jobCardId, resourceId, start, workingMinutes, siteIds: vis.activeSiteIds, act: 'move' }); // placement = new work (card lookup above stays broad)
        // ── THE AUDIT ROW CARRIES WHERE IT CAME FROM, NOT ONLY WHERE IT WENT ──────────────────
        // It used to record the destination alone, which cannot answer the question anybody asks
        // of a moved booking ("where was it?") and cannot support an undo. Two facts, from the
        // transaction that wrote them.
        await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'booking.moved', diff: { from: moved.from, to: moved.to } });
        from = moved.from;
      });
      // `from` goes back to the caller so the diary can offer UNDO — which is a second move, with
      // its own refusals and its own audit row, never an erasure of the first.
      return res.status(200).json({ message: 'Job card placed.', from });
    } catch (err: any) {
      const m = err?.message || '';
      if (m === 'CARD_NOT_FOUND') return res.status(404).json({ message: 'Job card not found.' });
      if (m === 'FORBIDDEN') return res.status(403).json({ message: 'Only a manager or admin can schedule a job.' });
      if (m === 'RESOURCE_NOT_FOUND') return res.status(404).json({ message: 'Resource not found.' });
      if (m === 'CROSS_SITE') return res.status(400).json({ message: 'A job card can only be placed on a resource at its own location.' });
      if (m === 'EMPTY_FOOTPRINT') return res.status(400).json({ message: 'A valid duration is required.' });
      // 409, not 400: the request is well formed and the card's state refuses it. The words name
      // the status AND THE DOOR THAT WORKS — "you cannot move this" without saying what to do
      // instead is what a person retries. The door comes from the transition table
      // (lib/jobcard-status::reBookingDoor), so a lifecycle change moves the sentence with it, and
      // a status with no way back says nothing rather than pointing at a button that is not there.
      if (m.startsWith('SLOT_IS_HISTORY:')) {
        const status = m.split(':')[1];
        const door = reBookingDoor(status);
        const next = door === 'accept' ? ' Accept it to re-book the car.'
          : door === 'reopen' ? ' Reopen it to a draft first, then book it.'
          : '';
        return res.status(409).json({ code: 'SLOT_IS_HISTORY', status, door,
          message: `That job is ${status.replace('_', ' ')} — its slot is a record of what happened, not a plan, so it cannot be moved.${next}` });
      }
      if (m === 'SPAN_TOO_LONG') {
        return res.status(400).json({ code: 'SPAN_TOO_LONG',
          message: 'That duration would stretch the booking over more than a fortnight of calendar time, which the double-booking check cannot see past. Split it into separate jobs.' });
      }
      if (m === 'NOT_WORKING_TIME') {
        return res.status(400).json({ code: 'NOT_WORKING_TIME',
          message: 'The garage is closed then. Drop it inside opening hours — it will not be nudged to the next open slot.' });
      }
      if (m === 'BILLING_RESTRICTED') return res.status(402).json({ code: 'billing_restricted', message: 'Your subscription payment hasn’t arrived, so new bookings are paused. Everything already in the workshop can be finished, quoted and invoiced as normal.' });
      if (m.startsWith('CLASH:')) {
        return res.status(409).json({ code: 'CLASH', message: 'That resource isn’t available for that duration. Double-booking refused.', clash: true });
      }
      console.error('Diary place error:', err);
      return res.status(500).json({ message: 'Failed to place job card.' });
    }
  }

  if (req.method === 'DELETE') {
    const jobCardId = (req.query.jobCardId as string) || (req.body && (req.body.jobCardId as string));
    if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });
    const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, site_id: { in: vis.siteIds } }, select: { id: true, site_id: true } });
    if (!card) return res.status(404).json({ message: 'Job card not found.' });
    // Unscheduling is also resource allocation → manager/admin only.
    if (!canManageSite(vis, card.site_id)) return res.status(403).json({ message: 'Only a manager or admin can schedule a job.' });
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCard.update({
        where: { id: jobCardId },
        data: { resource_id: null, start_at: null, end_at: null, held_on_lift: false, scheduled_date: null, start_slot: null, end_slot: null },
      });
      await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'booking.removed' });
    });
    return res.status(200).json({ message: 'Job card unplaced.' });
  }

  res.setHeader('Allow', 'PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
