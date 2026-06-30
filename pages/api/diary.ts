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

  if (req.method === 'PATCH') {
    const { jobCardId, resourceId, startAt, endAt, heldOnLift } = (req.body || {}) as {
      jobCardId?: string; resourceId?: string; startAt?: string; endAt?: string; heldOnLift?: boolean;
    };
    if (!jobCardId || !resourceId) {
      return res.status(400).json({ message: 'jobCardId and resourceId are required.' });
    }
    const start = parseDateTime(startAt);
    const end = parseDateTime(endAt);
    if (!start || !end) return res.status(400).json({ message: 'startAt and endAt must be valid datetimes.' });
    if (start >= end) return res.status(400).json({ message: 'startAt must be before endAt.' });

    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Visibility scope: the card must sit on a site the caller may access.
        const card = await tx.jobCard.findFirst({ where: { id: jobCardId, site_id: { in: vis.siteIds } }, select: { id: true, site_id: true } });
        if (!card) throw new Error('CARD_NOT_FOUND');

        // Scheduling = resource allocation = commercial: manager/admin only (one rule for diary + card).
        if (!canManageSite(vis, card.site_id)) throw new Error('FORBIDDEN');

        // The target resource must also be on a site the caller may access.
        const resource = await tx.resource.findFirst({
          where: { id: resourceId, site_id: { in: vis.siteIds } },
          select: { id: true, site_id: true },
        });
        if (!resource) throw new Error('RESOURCE_NOT_FOUND');
        if (resource.site_id !== card.site_id) throw new Error('CROSS_SITE');

        // Interval-overlap guard (half-open): existing.start < new.end AND existing.end > new.start.
        const clash = await tx.jobCard.findFirst({
          where: {
            id: { not: jobCardId },
            resource_id: resourceId,
            start_at: { lt: end },
            end_at: { gt: start },
          },
          select: { id: true, vehicle: { select: { registration: true } } },
        });
        if (clash) throw new Error(`CLASH:${clash.vehicle?.registration ?? 'another job'}`);

        await tx.jobCard.update({
          where: { id: jobCardId },
          data: {
            resource_id: resourceId, start_at: start, end_at: end,
            ...(heldOnLift !== undefined ? { held_on_lift: !!heldOnLift } : {}),
          },
        });
      });
      return res.status(200).json({ message: 'Job card placed.' });
    } catch (err: any) {
      const m = err?.message || '';
      if (m === 'CARD_NOT_FOUND') return res.status(404).json({ message: 'Job card not found.' });
      if (m === 'FORBIDDEN') return res.status(403).json({ message: 'Only a manager or admin can schedule a job.' });
      if (m === 'RESOURCE_NOT_FOUND') return res.status(404).json({ message: 'Resource not found.' });
      if (m === 'CROSS_SITE') return res.status(400).json({ message: 'A job card can only be placed on a resource at its own location.' });
      if (m.startsWith('CLASH:')) {
        return res.status(409).json({ message: `Time overlaps ${m.slice(6)} on this resource. Double-booking refused.`, clash: true });
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
    await prisma.jobCard.update({
      where: { id: jobCardId },
      data: { resource_id: null, start_at: null, end_at: null, held_on_lift: false, scheduled_date: null, start_slot: null, end_slot: null },
    });
    return res.status(200).json({ message: 'Job card unplaced.' });
  }

  res.setHeader('Allow', 'PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
