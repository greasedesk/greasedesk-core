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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);

  if (req.method === 'GET') {
    const y = Number(req.query.year) || new Date().getUTCFullYear();
    const roster = await buildRoster(user.group_id as string, vis, y);
    return res.status(200).json(roster);
  }

  if (req.method === 'PATCH') {
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can change allowances.' });
    const { costPersonId, allowanceDays } = (req.body || {}) as { costPersonId?: string; allowanceDays?: number };
    const days = Number(allowanceDays);
    if (!costPersonId || !Number.isFinite(days) || days < 0 || days > 366) {
      return res.status(400).json({ message: 'Enter a valid allowance in days.' });
    }
    const person = await prisma.costPerson.findFirst({ where: { id: costPersonId, group_id: user.group_id }, select: { id: true } });
    if (!person) return res.status(404).json({ message: 'Person not found.' });
    await prisma.costPerson.update({ where: { id: costPersonId }, data: { annual_leave_allowance_days: days } });
    return res.status(200).json({ message: 'Allowance saved.' });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
