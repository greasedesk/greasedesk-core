/**
 * File: pages/api/service-tiers.ts
 * ServiceTier CRUD — the tenant's OPTIONAL vehicle/price tiers for fixed-price services. ADMIN-only,
 * tenant-scoped. Zero tiers = single-price world. Deleting a tier cascades its per-item price rows.
 *   GET                              → { tiers[] }
 *   POST   { name, position? }
 *   PATCH  { id, name?, position?, active? }
 *   DELETE { id }
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId;

  if (req.method === 'GET') {
    const tiers = (await prisma.serviceTier.findMany({
      where: { group_id: groupId }, orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
      select: { id: true, name: true, position: true, active: true },
    })) as any[];
    return res.status(200).json({ tiers: tiers.map((t) => ({ id: t.id, name: t.name, position: t.position, active: t.active })) });
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = (req.body || {}) as any;
    const isPatch = req.method === 'PATCH';
    const id = typeof body.id === 'string' ? body.id : '';
    if (isPatch && !id) return res.status(400).json({ message: 'Missing id.' });

    const data: any = {};
    if (body.name !== undefined || !isPatch) {
      const name = String(body.name ?? '').trim();
      if (!name) return res.status(400).json({ message: 'Tier name is required.' });
      data.name = name;
    }
    if (body.position !== undefined) { const n = Number(body.position); data.position = Number.isFinite(n) ? Math.trunc(n) : 0; }
    if (body.active !== undefined) data.active = !!body.active;

    if (isPatch) {
      const owned = await prisma.serviceTier.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
      if (!owned) return res.status(404).json({ message: 'Tier not found.' });
      await prisma.serviceTier.update({ where: { id }, data });
      return res.status(200).json({ message: 'Tier updated.' });
    }
    // Default position to the end.
    if (data.position === undefined) data.position = await prisma.serviceTier.count({ where: { group_id: groupId } });
    const created = await prisma.serviceTier.create({ data: { group_id: groupId, ...data }, select: { id: true } });
    return res.status(201).json({ id: created.id, message: 'Tier added.' });
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : (req.body?.id as string) || '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const del = await prisma.serviceTier.deleteMany({ where: { id, group_id: groupId } }); // price rows cascade
    if (del.count === 0) return res.status(404).json({ message: 'Tier not found.' });
    return res.status(200).json({ message: 'Tier deleted.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
