/**
 * File: pages/api/diary.ts
 * Place / move / unplace a JobCard on a Resource over a continuous time interval.
 * start_at / end_at are the scheduling source of truth (half-open interval [start, end)).
 * Tenant-scoped to the caller's group; a card may only be placed on a Resource of its OWN site.
 *
 *   PATCH  { jobCardId, resourceId, startAt, endAt }  (ISO datetimes) → place/move
 *   DELETE { jobCardId }                                              → unplace
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
import { writeAudit } from '@/lib/audit';
import { requireModuleApi } from '@/lib/modules';

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
  // SERVER-SIDE — hiding the diary's controls is not a guard. No-op today: every tenant is seeded
  // with booking enabled, so this changes nothing until Booking is actually sold.
  if (req.method === 'PATCH' || req.method === 'DELETE') {
    if (!(await requireModuleApi(res, user.group_id as string, 'booking'))) return;
  }

  if (req.method === 'PATCH') {
    const { jobCardId, resourceId, startAt, endAt, workingMinutes: wmIn } = (req.body || {}) as {
      jobCardId?: string; resourceId?: string; startAt?: string; endAt?: string; workingMinutes?: number;
    };
    if (!jobCardId || !resourceId) {
      return res.status(400).json({ message: 'jobCardId and resourceId are required.' });
    }
    const start = parseDateTime(startAt);
    if (!start) return res.status(400).json({ message: 'startAt must be a valid datetime.' });
    // Duration = source of truth. Bridge: a caller sending endAt (diary drag, old form) yields the
    // same working-minutes via (end - start).
    const workingMinutes = wmIn ?? (endAt ? Math.round((Date.parse(endAt) - start.getTime()) / 60000) : NaN);
    if (!(workingMinutes > 0)) return res.status(400).json({ message: 'A valid duration is required.' });

    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Scheduling = resource allocation = commercial: manager/admin only (one rule for diary + card).
        const card = await tx.jobCard.findFirst({ where: { id: jobCardId, site_id: { in: vis.siteIds } }, select: { site_id: true } });
        if (!card) throw new Error('CARD_NOT_FOUND');
        if (!canManageSite(vis, card.site_id)) throw new Error('FORBIDDEN');
        // Shared guard (scope + footprint-overlap + update) — the one place placement happens.
        await placeJobCard(tx, { jobCardId, resourceId, start, workingMinutes, siteIds: vis.activeSiteIds }); // placement = new work (card lookup above stays broad)
        await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'booking.moved', diff: { resourceId, startAt, workingMinutes } });
      });
      return res.status(200).json({ message: 'Job card placed.' });
    } catch (err: any) {
      const m = err?.message || '';
      if (m === 'CARD_NOT_FOUND') return res.status(404).json({ message: 'Job card not found.' });
      if (m === 'FORBIDDEN') return res.status(403).json({ message: 'Only a manager or admin can schedule a job.' });
      if (m === 'RESOURCE_NOT_FOUND') return res.status(404).json({ message: 'Resource not found.' });
      if (m === 'CROSS_SITE') return res.status(400).json({ message: 'A job card can only be placed on a resource at its own location.' });
      if (m === 'EMPTY_FOOTPRINT') return res.status(400).json({ message: 'A valid duration is required.' });
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
