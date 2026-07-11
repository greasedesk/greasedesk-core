/**
 * File: pages/api/roster.ts
 * GET ?year= → the role-scoped Roster (lib/roster — ADMIN all, manager their sites' people +
 * self, STANDARD self only). PATCH { costPersonId, allowanceDays } → ADMIN-only edit of a
 * person's annual leave allowance (per-person figure; the manual home of pro-rated values
 * until auto pro-rata from start_date lands — banked).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { buildRoster } from '@/lib/roster';
import { LEAVE_TYPES, resolveLeaveColours } from '@/lib/leave-types';
import { Prisma } from '@prisma/client';
import { recordEmploymentEvents } from '@/lib/employment-events';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);

  if (req.method === 'GET') {
    const y = Number(req.query.year) || new Date().getUTCFullYear();
    const [roster, grp] = await Promise.all([
      buildRoster(user.group_id as string, vis, y),
      prisma.group.findUnique({ where: { id: user.group_id }, select: { leave_type_colours: true } }) as any,
    ]);
    return res.status(200).json({ ...roster, colours: resolveLeaveColours(grp?.leave_type_colours) });
  }

  if (req.method === 'PATCH') {
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can change this.' });
    const { costPersonId, allowanceDays, leaveColours } = (req.body || {}) as { costPersonId?: string; allowanceDays?: number; leaveColours?: Record<string, string> };
    // Per-type colour remap (accessibility) — validated to known types + #rrggbb, stored whole.
    if (leaveColours !== undefined) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(leaveColours || {})) {
        if ((LEAVE_TYPES as readonly string[]).includes(k) && /^#[0-9a-fA-F]{6}$/.test(String(v))) clean[k] = String(v);
      }
      await prisma.group.update({ where: { id: user.group_id }, data: { leave_type_colours: clean } });
      return res.status(200).json({ message: 'Colours saved.', colours: resolveLeaveColours(clean) });
    }
    const days = Number(allowanceDays);
    if (!costPersonId || !Number.isFinite(days) || days < 0 || days > 366) {
      return res.status(400).json({ message: 'Enter a valid allowance in days.' });
    }
    const person = (await prisma.costPerson.findFirst({ where: { id: costPersonId, group_id: user.group_id }, select: { id: true, annual_leave_allowance_days: true } })) as any;
    if (!person) return res.status(404).json({ message: 'Person not found.' });
    const prev = person.annual_leave_allowance_days == null ? null : Number(person.annual_leave_allowance_days);
    if (prev === days) return res.status(200).json({ message: 'Allowance saved.' });
    // DUAL-WRITE (record-first): flat column + dated event in ONE tx (effective today — the
    // Roster's quick edit; back-dated allowance changes go through HR when that lands).
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.costPerson.update({ where: { id: costPersonId }, data: { annual_leave_allowance_days: days } });
      await recordEmploymentEvents(tx, {
        groupId: user.group_id as string, costPersonId, changedBy: user.id as string, effectiveDate: today,
        changes: [{ kind: 'allowance', value: { annual_leave_allowance_days: days }, previous: { annual_leave_allowance_days: prev } }],
      });
    });
    return res.status(200).json({ message: 'Allowance saved.' });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
