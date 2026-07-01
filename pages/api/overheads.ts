/**
 * File: pages/api/overheads.ts
 * Cost-capture — Overheads (open-ended business costs) CRUD. ADMIN/owner ONLY via requireAdminApi:
 * business costs are sensitive, so no value is ever built into a non-admin payload — a SITE_MANAGER
 * gets 403 here and receives nothing. Allocations validated in lib/cost-allocation.ts (the one
 * place the 100%-sum + tenant-site invariant lives); writes replace allocations atomically.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { validateAllocations } from '@/lib/cost-allocation';

const PERIODS = new Set(['weekly', 'monthly', 'annual']);

const toPennies = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res); // 401/403 handled inside
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });
  const groupId = vis.groupId;

  const sites: Array<{ id: string; site_name: string; is_active: boolean }> = await prisma.site.findMany({
    where: { group_id: groupId },
    select: { id: true, site_name: true, is_active: true },
    orderBy: { site_name: 'asc' },
  });
  const tenantSiteIds = sites.map((s) => s.id);

  // ---- GET: list overheads + allocations, plus sites for the editor/by-site pivot ----
  if (req.method === 'GET') {
    const overheads: Array<{
      id: string; name: string; amount_pennies: number; period: 'weekly' | 'monthly' | 'annual';
      is_active: boolean; allocations: Array<{ site_id: string; percent: unknown }>;
    }> = await prisma.overhead.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true, name: true, amount_pennies: true, period: true, is_active: true,
        allocations: { select: { site_id: true, percent: true } },
      },
    });
    return res.status(200).json({
      sites: sites.map((s) => ({ id: s.id, name: s.site_name, isActive: s.is_active })),
      overheads: overheads.map((o) => ({
        id: o.id, name: o.name, amountPennies: o.amount_pennies, period: o.period, isActive: o.is_active,
        allocations: o.allocations.map((a) => ({ siteId: a.site_id, percent: Number(a.percent) })),
      })),
    });
  }

  // ---- POST / PATCH: create or update an overhead + replace its allocations atomically ----
  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = (req.body || {}) as any;
    const isPatch = req.method === 'PATCH';
    const id = typeof body.id === 'string' ? body.id : '';
    if (isPatch && !id) return res.status(400).json({ message: 'Missing id.' });

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const period = String(body.period || '');
    const amountPennies = toPennies(body.amountPennies);

    if (!name) return res.status(400).json({ message: 'Name is required.' });
    if (!PERIODS.has(period)) return res.status(400).json({ message: 'Period must be weekly, monthly or annual.' });
    if (amountPennies === null) return res.status(400).json({ message: 'Amount must be a non-negative number of pennies.' });

    const check = validateAllocations(body.allocations, tenantSiteIds);
    if (!check.ok) return res.status(400).json({ message: check.error });

    if (isPatch) {
      const owned = await prisma.overhead.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
      if (!owned) return res.status(404).json({ message: 'Overhead not found.' });
    }

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const overhead = isPatch
        ? await tx.overhead.update({
            where: { id },
            data: { name, period: period as any, amount_pennies: amountPennies },
            select: { id: true },
          })
        : await tx.overhead.create({
            data: { group_id: groupId, name, period: period as any, amount_pennies: amountPennies },
            select: { id: true },
          });
      await tx.costAllocation.deleteMany({ where: { overhead_id: overhead.id } });
      await tx.costAllocation.createMany({
        data: check.rows.map((r) => ({
          group_id: groupId, site_id: r.siteId, percent: new Prisma.Decimal(r.percent), overhead_id: overhead.id,
        })),
      });
      return overhead;
    });

    return res.status(isPatch ? 200 : 201).json({ id: result.id, message: isPatch ? 'Overhead updated.' : 'Overhead added.' });
  }

  // ---- DELETE: remove an overhead (allocations cascade) ----
  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : (req.body?.id as string) || '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const del = await prisma.overhead.deleteMany({ where: { id, group_id: groupId } });
    if (del.count === 0) return res.status(404).json({ message: 'Overhead not found.' });
    return res.status(200).json({ message: 'Overhead removed.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
