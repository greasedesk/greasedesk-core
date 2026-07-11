/**
 * File: pages/api/roster-leave.ts
 * Leave CRUD — the Roster's ONLY write path (v1 approved-only; the mechanic request→approve
 * flow is banked and lands on this same table).
 *
 * POST { costPersonId, startDate, endDate?, halfDay?, hours?, type }
 *   Range bookings expand PER-DAY via lib/roster.planLeaveRange, which reads THE capacity
 *   rostered-day helpers (rosteredWeekdays/isRosteredOn/phDaySet — one truth, so expansion and
 *   capacity can never diverge). Only working days are booked; bank holidays and already-booked
 *   days are SKIPPED AND REPORTED per-day (never a silent shortfall). All created rows share one
 *   leave_batch_id. halfDay (start=end only) writes hours = contracted/2; a custom hours value
 *   (kept as the advanced single-day option) is validated ≤ contracted, rejected otherwise.
 * PATCH { batchId, startDate, endDate, type? } — re-expands the batch (delete + re-create, same
 *   id).  PATCH { id, ... } — legacy single-row edit (null-batch rows).
 * DELETE { batchId } — removes the whole booking.  DELETE { id } — legacy single row.
 *
 * LeaveRecord.site_id is ATTRIBUTION ONLY (the person's home site) — capacity apportionment
 * happens in getAvailableHours via CostAllocation %, never from this column.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canEditPersonLeave, planLeaveRange } from '@/lib/roster';
import { phDaySet, dayKey } from '@/lib/capacity';

const TYPES = ['annual', 'sick', 'other', 'closure'];
const parseDay = (s: unknown): Date | null => {
  const ds = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return null;
  const d = new Date(`${ds}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

function hoursError(hours: unknown, contracted: number | null): string | null {
  if (hours == null || hours === '') return null;
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return 'Enter the hours as a number greater than zero.';
  if (contracted == null) return 'Set this person’s contracted hours per day before booking part-day leave.';
  if (h > contracted) return `That’s more than their ${contracted}h contracted day — enter ${contracted}h or less.`;
  return null;
}

/** Home-site of a person (highest allocation %; group's first site as backstop) — attribution +
 *  the open_days/PH context for expansion. */
async function homeSiteOf(groupId: string, person: any): Promise<{ id: string; open_days: number[] }> {
  const allocs = [...person.allocations].sort((a: any, b: any) => Number(b.percent) - Number(a.percent));
  const sid = allocs[0]?.site_id;
  const site = sid
    ? ((await prisma.site.findFirst({ where: { id: sid, group_id: groupId }, select: { id: true, open_days: true } })) as any)
    : null;
  if (site) return site;
  return (await prisma.site.findFirst({ where: { group_id: groupId }, orderBy: { created_at: 'asc' }, select: { id: true, open_days: true } })) as any;
}

/** Expand + create a booking's rows. Returns the ground-truth booked dates + reported skips. */
async function createBooking(groupId: string, userId: string, person: any, site: { id: string; open_days: number[] }, start: Date, end: Date, type: string, hours: number | null, batchId: string) {
  const phDays = await phDaySet(groupId, site.id, { from: start, to: new Date(end.getTime() + 86_400_000) });
  const existing = (await prisma.leaveRecord.findMany({
    where: { cost_person_id: person.id, date: { gte: start, lte: end } }, select: { date: true },
  })) as any[];
  const plan = planLeaveRange(start, end, person.working_days ?? [], site.open_days, phDays, new Set(existing.map((r) => dayKey(r.date))));
  if (plan.book.length) {
    await prisma.leaveRecord.createMany({
      data: plan.book.map((day) => ({
        group_id: groupId, cost_person_id: person.id, site_id: site.id,
        date: new Date(`${day}T00:00:00.000Z`), hours, type: type as any,
        leave_batch_id: batchId, created_by: userId,
      })),
      skipDuplicates: true, // race backstop; pre-check above already reported overlaps
    });
  }
  // Ground truth from the DB (a raced duplicate shows up as not-created).
  const created = (await prisma.leaveRecord.findMany({ where: { leave_batch_id: batchId }, select: { date: true }, orderBy: { date: 'asc' } })) as any[];
  const createdDays = created.map((r) => dayKey(r.date));
  const raced = plan.book.filter((d) => !createdDays.includes(d)).map((date) => ({ date, reason: 'alreadyBooked' as const }));
  return { booked: createdDays, skipped: [...plan.skipped, ...raced] };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);
  const groupId = user.group_id as string;

  try {
    if (req.method === 'POST') {
      const { costPersonId, startDate, endDate, halfDay, hours, type } = (req.body || {}) as any;
      const start = parseDay(startDate);
      const end = endDate ? parseDay(endDate) : start;
      if (!costPersonId || !start || !end) return res.status(400).json({ message: 'Pick a person and valid dates.' });
      if (end.getTime() < start.getTime()) return res.status(400).json({ message: 'The end date can’t be before the start date.' });
      if (!TYPES.includes(String(type || 'annual'))) return res.status(400).json({ message: 'Pick a valid leave type.' });
      const isRange = end.getTime() > start.getTime();
      if (isRange && (halfDay || (hours != null && hours !== ''))) {
        return res.status(400).json({ message: 'Half days and custom hours are for single-day bookings only.' });
      }
      const perm = await canEditPersonLeave(groupId, vis, costPersonId);
      if (!perm.ok) return res.status(403).json({ message: 'You can’t manage leave for this person.' });
      const contracted = perm.person.contracted_hours_per_day == null ? null : Number(perm.person.contracted_hours_per_day);
      let rowHours: number | null = null;
      if (!isRange) {
        if (halfDay) {
          if (contracted == null) return res.status(400).json({ message: 'Set this person’s contracted hours per day before booking a half day.' });
          rowHours = contracted / 2;
        } else if (hours != null && hours !== '') {
          const hErr = hoursError(hours, contracted);
          if (hErr) return res.status(400).json({ message: hErr });
          rowHours = Number(hours);
        }
      }
      const person = (await prisma.costPerson.findFirst({ where: { id: costPersonId, group_id: groupId }, select: { id: true, working_days: true, allocations: { select: { site_id: true, percent: true } } } })) as any;
      const site = await homeSiteOf(groupId, person);
      const result = await createBooking(groupId, user.id, person, site, start, end, String(type || 'annual'), rowHours, randomUUID());
      return res.status(200).json({ message: 'Leave booked.', ...result });
    }

    if (req.method === 'PATCH') {
      const { batchId, id, startDate, endDate, date, hours, type } = (req.body || {}) as any;

      if (batchId) {
        // Batch edit = re-expansion: remove the batch's rows, re-create over the new range.
        const rows = (await prisma.leaveRecord.findMany({ where: { leave_batch_id: batchId, group_id: groupId }, select: { id: true, cost_person_id: true, type: true, hours: true } })) as any[];
        if (!rows.length) return res.status(404).json({ message: 'Booking not found.' });
        const perm = await canEditPersonLeave(groupId, vis, rows[0].cost_person_id);
        if (!perm.ok) return res.status(403).json({ message: 'You can’t manage leave for this person.' });
        const start = parseDay(startDate); const end = parseDay(endDate);
        if (!start || !end) return res.status(400).json({ message: 'Pick valid dates.' });
        if (end.getTime() < start.getTime()) return res.status(400).json({ message: 'The end date can’t be before the start date.' });
        const newType = type !== undefined ? String(type) : rows[0].type;
        if (!TYPES.includes(newType)) return res.status(400).json({ message: 'Pick a valid leave type.' });
        const isRange = end.getTime() > start.getTime();
        const keepHours = isRange ? null : (rows.length === 1 ? (rows[0].hours == null ? null : Number(rows[0].hours)) : null);
        await prisma.leaveRecord.deleteMany({ where: { leave_batch_id: batchId, group_id: groupId } });
        const person = (await prisma.costPerson.findFirst({ where: { id: rows[0].cost_person_id, group_id: groupId }, select: { id: true, working_days: true, allocations: { select: { site_id: true, percent: true } } } })) as any;
        const site = await homeSiteOf(groupId, person);
        const result = await createBooking(groupId, user.id, person, site, start, end, newType, keepHours, batchId);
        return res.status(200).json({ message: 'Booking updated.', ...result });
      }

      // Legacy single-row edit (null-batch rows only).
      if (!id) return res.status(400).json({ message: 'Missing leave id.' });
      const row = (await prisma.leaveRecord.findFirst({ where: { id, group_id: groupId }, select: { id: true, cost_person_id: true } })) as any;
      if (!row) return res.status(404).json({ message: 'Leave entry not found.' });
      const perm = await canEditPersonLeave(groupId, vis, row.cost_person_id);
      if (!perm.ok) return res.status(403).json({ message: 'You can’t manage leave for this person.' });
      const data: any = {};
      if (date !== undefined) {
        const d = parseDay(date);
        if (!d) return res.status(400).json({ message: 'Enter a valid date.' });
        data.date = d;
      }
      if (type !== undefined) {
        if (!TYPES.includes(String(type))) return res.status(400).json({ message: 'Pick a valid leave type.' });
        data.type = String(type);
      }
      if (hours !== undefined) {
        const contracted = perm.person.contracted_hours_per_day == null ? null : Number(perm.person.contracted_hours_per_day);
        const hErr = hoursError(hours === null || hours === '' ? null : hours, contracted);
        if (hErr) return res.status(400).json({ message: hErr });
        data.hours = hours === null || hours === '' ? null : Number(hours);
      }
      await prisma.leaveRecord.update({ where: { id }, data });
      return res.status(200).json({ message: 'Leave updated.' });
    }

    if (req.method === 'DELETE') {
      const { id, batchId } = (req.body || {}) as any;
      if (batchId) {
        const rows = (await prisma.leaveRecord.findMany({ where: { leave_batch_id: batchId, group_id: groupId }, select: { cost_person_id: true } })) as any[];
        if (!rows.length) return res.status(404).json({ message: 'Booking not found.' });
        const perm = await canEditPersonLeave(groupId, vis, rows[0].cost_person_id);
        if (!perm.ok) return res.status(403).json({ message: 'You can’t manage leave for this person.' });
        await prisma.leaveRecord.deleteMany({ where: { leave_batch_id: batchId, group_id: groupId } });
        return res.status(200).json({ message: 'Booking removed.' });
      }
      if (!id) return res.status(400).json({ message: 'Missing leave id.' });
      const row = (await prisma.leaveRecord.findFirst({ where: { id, group_id: groupId }, select: { id: true, cost_person_id: true } })) as any;
      if (!row) return res.status(404).json({ message: 'Leave entry not found.' });
      const perm = await canEditPersonLeave(groupId, vis, row.cost_person_id);
      if (!perm.ok) return res.status(403).json({ message: 'You can’t manage leave for this person.' });
      await prisma.leaveRecord.delete({ where: { id } });
      return res.status(200).json({ message: 'Leave removed.' });
    }
  } catch (e: any) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ message: 'They already have leave that day — edit the existing entry instead.' });
    }
    console.error('Roster leave error:', e);
    return res.status(500).json({ message: 'Could not save the leave entry.' });
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
