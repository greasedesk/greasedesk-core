/**
 * File: pages/api/roster-leave.ts
 * Leave CRUD — the Roster's ONLY write path (v1: every row is manager/admin-entered, status
 * approved; the mechanic request→approve flow is banked and lands on this same table).
 * POST { costPersonId, date, hours?, type } · PATCH { id, date?, hours?, type? } · DELETE { id }.
 * Permission per-person via lib/roster canEditPersonLeave (ADMIN anyone; manager = people
 * allocated to their manageable sites). Validations (binding):
 *  - hours-override requires contracted hours set and must be ≤ them — REJECTED with a clear
 *    message, never silently clamped;
 *  - one row per person-day: a unique collision returns "already has leave that day — edit it".
 * LeaveRecord.site_id is ATTRIBUTION ONLY (the person's home site) — capacity apportionment
 * happens in getAvailableHours via CostAllocation %, never from this column.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canEditPersonLeave } from '@/lib/roster';

const TYPES = ['annual', 'sick', 'other', 'closure'];
const parseDay = (s: unknown): Date | null => {
  const ds = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return null;
  const d = new Date(`${ds}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Hours-override guardrail. Returns an error message or null. */
function hoursError(hours: unknown, contracted: number | null): string | null {
  if (hours == null || hours === '') return null; // full rostered day
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return 'Enter the hours as a number greater than zero.';
  if (contracted == null) return 'Set this person’s contracted hours per day before booking part-day leave.';
  if (h > contracted) return `That’s more than their ${contracted}h contracted day — enter ${contracted}h or less.`;
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);
  const groupId = user.group_id as string;

  try {
    if (req.method === 'POST') {
      const { costPersonId, date, hours, type } = (req.body || {}) as any;
      const d = parseDay(date);
      if (!costPersonId || !d) return res.status(400).json({ message: 'Pick a person and a valid date.' });
      if (!TYPES.includes(String(type || 'annual'))) return res.status(400).json({ message: 'Pick a valid leave type.' });
      const perm = await canEditPersonLeave(groupId, vis, costPersonId);
      if (!perm.ok) return res.status(403).json({ message: 'You can’t manage leave for this person.' });
      const contracted = perm.person.contracted_hours_per_day == null ? null : Number(perm.person.contracted_hours_per_day);
      const hErr = hoursError(hours, contracted);
      if (hErr) return res.status(400).json({ message: hErr });
      // Attribution site = the person's home (highest-%) allocation; group's first site as backstop.
      const allocs = [...perm.person.allocations].sort((a: any, b: any) => Number(b.percent) - Number(a.percent));
      const siteId = allocs[0]?.site_id
        ?? ((await prisma.site.findFirst({ where: { group_id: groupId }, orderBy: { created_at: 'asc' }, select: { id: true } }))!).id;
      await prisma.leaveRecord.create({
        data: { group_id: groupId, cost_person_id: costPersonId, site_id: siteId, date: d, hours: hours == null || hours === '' ? null : Number(hours), type: String(type || 'annual') as any, created_by: user.id },
      });
      return res.status(200).json({ message: 'Leave added.' });
    }

    if (req.method === 'PATCH') {
      const { id, date, hours, type } = (req.body || {}) as any;
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
      const { id } = (req.body || {}) as any;
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
      // @@unique([cost_person_id, date]) — friendly, actionable, never a raw DB error.
      return res.status(409).json({ message: 'They already have leave that day — edit the existing entry instead.' });
    }
    console.error('Roster leave error:', e);
    return res.status(500).json({ message: 'Could not save the leave entry.' });
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
