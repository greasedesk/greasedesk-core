/**
 * File: pages/api/payment-methods.ts
 * Payment methods list + admin CRUD (follows the service-tiers pattern):
 *   GET               → active methods (manager/admin — the mark-paid picker needs them)
 *   GET ?all=1        → incl. archived (the settings editor; admin)
 *   POST  { name, behaviour }             (ADMIN)
 *   PATCH { id, name?, behaviour?, active? } (ADMIN)
 * Behaviour changes affect FUTURE mark-paids only — an invoice's clearance path is decided at
 * mark-paid (its confirm_due_at / instant confirm are already set); history never reinterprets.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { getPaymentMethods } from '@/lib/payment-methods';

const BEHAVIOURS = ['instant', 'windowed', 'manual'] as const;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);

  if (req.method === 'GET') {
    if (!(vis.isAdmin || vis.role === 'SITE_MANAGER')) return res.status(403).json({ message: 'You do not have permission to view payment methods.' });
    const methods = await getPaymentMethods(user.group_id as string, req.query.all === '1' && vis.isAdmin);
    return res.status(200).json({ methods });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can manage payment methods.' });
    const b = (req.body || {}) as { id?: string; name?: string; behaviour?: string; active?: boolean };
    const data: any = {};
    if (b.name !== undefined) {
      const n = String(b.name).trim();
      if (!n || n.length > 50) return res.status(400).json({ message: 'The method needs a name (up to 50 characters).' });
      data.name = n;
    }
    if (b.behaviour !== undefined) {
      if (!BEHAVIOURS.includes(b.behaviour as any)) return res.status(400).json({ message: 'Clearance must be instant, windowed or manual.' });
      data.behaviour = b.behaviour;
    }
    if (b.active !== undefined) data.active = !!b.active;

    if (req.method === 'POST') {
      if (!data.name || !data.behaviour) return res.status(400).json({ message: 'A name and a clearance behaviour are required.' });
      const max = await prisma.paymentMethod.count({ where: { group_id: user.group_id } });
      const row = await prisma.paymentMethod.create({ data: { group_id: user.group_id, ...data, position: max }, select: { id: true } });
      return res.status(201).json({ id: row.id });
    }
    if (!b.id) return res.status(400).json({ message: 'Missing id.' });
    const owned = await prisma.paymentMethod.findFirst({ where: { id: b.id, group_id: user.group_id }, select: { id: true } });
    if (!owned) return res.status(404).json({ message: 'Payment method not found.' });
    if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update.' });
    await prisma.paymentMethod.update({ where: { id: b.id }, data });
    return res.status(200).json({ message: 'Payment method saved.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
