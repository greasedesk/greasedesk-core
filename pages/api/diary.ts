/**
 * File: pages/api/diary.ts
 * Place / move / unplace a JobCard on a Resource + time slot. Tenant-scoped to the
 * caller's group; a card may only be placed on a Resource of its OWN site.
 *
 *   PATCH  { jobCardId, resourceId, date 'YYYY-MM-DD', startSlot, endSlot } → place/move
 *   DELETE { jobCardId }                                                    → unplace
 *
 * HARD RULE: never silently overwrite. Placement runs a double-booking guard inside a
 * transaction and REFUSES (409) if the resource+date+slot range clashes with another card.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';

export const SLOT_COUNT = 4; // four fixed slots (09–11, 11–13, 14–16, 16–18)

function parseDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return res.status(401).json({ message: 'Authentication Error: Group/Site context not found.' });
  }
  const groupId = user.group_id as string;

  if (req.method === 'PATCH') {
    const { jobCardId, resourceId, date, startSlot, endSlot } = (req.body || {}) as {
      jobCardId?: string; resourceId?: string; date?: string; startSlot?: number; endSlot?: number;
    };
    if (!jobCardId || !resourceId || !date) {
      return res.status(400).json({ message: 'jobCardId, resourceId and date are required.' });
    }
    const dateObj = parseDate(date);
    if (!dateObj) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });

    const s = Number(startSlot);
    const e = Number(endSlot);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0 || s >= SLOT_COUNT || e >= SLOT_COUNT || s > e) {
      return res.status(400).json({ message: `Slots must be integers 0–${SLOT_COUNT - 1} with start ≤ end.` });
    }

    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const card = await tx.jobCard.findFirst({ where: { id: jobCardId, group_id: groupId }, select: { id: true, site_id: true } });
        if (!card) throw new Error('CARD_NOT_FOUND');

        const resource = await tx.resource.findFirst({
          where: { id: resourceId, site: { group_id: groupId } },
          select: { id: true, site_id: true },
        });
        if (!resource) throw new Error('RESOURCE_NOT_FOUND');
        if (resource.site_id !== card.site_id) throw new Error('CROSS_SITE');

        // Double-booking guard: any OTHER card overlapping this resource+date+slot range?
        const clash = await tx.jobCard.findFirst({
          where: {
            id: { not: jobCardId },
            resource_id: resourceId,
            scheduled_date: dateObj,
            start_slot: { lte: e },
            end_slot: { gte: s },
          },
          select: { id: true, start_slot: true, vehicle: { select: { registration: true } }, customer: { select: { name: true } } },
        });
        if (clash) {
          const reg = clash.vehicle?.registration ?? 'another job';
          throw new Error(`CLASH:${reg}`);
        }

        await tx.jobCard.update({
          where: { id: jobCardId },
          data: { resource_id: resourceId, scheduled_date: dateObj, start_slot: s, end_slot: e },
        });
      });
      return res.status(200).json({ message: 'Job card placed.' });
    } catch (err: any) {
      const m = err?.message || '';
      if (m === 'CARD_NOT_FOUND') return res.status(404).json({ message: 'Job card not found.' });
      if (m === 'RESOURCE_NOT_FOUND') return res.status(404).json({ message: 'Resource not found.' });
      if (m === 'CROSS_SITE') return res.status(400).json({ message: 'A job card can only be placed on a resource at its own location.' });
      if (m.startsWith('CLASH:')) {
        return res.status(409).json({ message: `Slot already taken by ${m.slice(6)}. Double-booking refused.`, clash: true });
      }
      console.error('Diary place error:', err);
      return res.status(500).json({ message: 'Failed to place job card.' });
    }
  }

  if (req.method === 'DELETE') {
    const jobCardId = (req.query.jobCardId as string) || (req.body && (req.body.jobCardId as string));
    if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });
    const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: groupId }, select: { id: true } });
    if (!card) return res.status(404).json({ message: 'Job card not found.' });
    await prisma.jobCard.update({
      where: { id: jobCardId },
      data: { resource_id: null, scheduled_date: null, start_slot: null, end_slot: null },
    });
    return res.status(200).json({ message: 'Job card unplaced.' });
  }

  res.setHeader('Allow', 'PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
