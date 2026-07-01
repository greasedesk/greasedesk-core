/**
 * File: pages/api/headcount.ts
 * Cost-capture — Headcount (people-as-costs) CRUD. ADMIN/owner ONLY via requireAdminApi:
 * wages are sensitive, so no cost value is ever built into a non-admin payload — a SITE_MANAGER
 * gets 403 here and receives nothing. Allocations validated in lib/cost-allocation.ts (the one
 * place the 100%-sum + tenant-site invariant lives); writes replace allocations atomically.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { validateAllocations } from '@/lib/cost-allocation';

const COST_TYPES = new Set(['salary', 'hourly']);

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

  // Tenant site allow-list (definitive, from DB — not the session).
  const sites: Array<{ id: string; site_name: string; is_active: boolean }> = await prisma.site.findMany({
    where: { group_id: groupId },
    select: { id: true, site_name: true, is_active: true },
    orderBy: { site_name: 'asc' },
  });
  const tenantSiteIds = sites.map((s) => s.id);

  // ---- GET: list people + their allocations, plus sites for the editor/by-site pivot ----
  if (req.method === 'GET') {
    const people: Array<{
      id: string; name: string; role: string | null; cost_type: 'salary' | 'hourly';
      amount_pennies: number; is_active: boolean; allocations: Array<{ site_id: string; percent: unknown }>;
    }> = await prisma.costPerson.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true, name: true, role: true, cost_type: true, amount_pennies: true, is_active: true,
        allocations: { select: { site_id: true, percent: true } },
      },
    });
    return res.status(200).json({
      sites: sites.map((s) => ({ id: s.id, name: s.site_name, isActive: s.is_active })),
      people: people.map((p) => ({
        id: p.id, name: p.name, role: p.role, costType: p.cost_type,
        amountPennies: p.amount_pennies, isActive: p.is_active,
        allocations: p.allocations.map((a) => ({ siteId: a.site_id, percent: Number(a.percent) })),
      })),
    });
  }

  // ---- POST / PATCH: create or update a person + replace its allocations atomically ----
  if (req.method === 'POST' || req.method === 'PATCH') {
    const body = (req.body || {}) as any;
    const isPatch = req.method === 'PATCH';
    const id = typeof body.id === 'string' ? body.id : '';
    if (isPatch && !id) return res.status(400).json({ message: 'Missing id.' });

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : null;
    const costType = String(body.costType || '');
    const amountPennies = toPennies(body.amountPennies);

    if (!name) return res.status(400).json({ message: 'Name is required.' });
    if (!COST_TYPES.has(costType)) return res.status(400).json({ message: 'Cost type must be salary or hourly.' });
    if (amountPennies === null) return res.status(400).json({ message: 'Amount must be a non-negative number of pennies.' });

    const check = validateAllocations(body.allocations, tenantSiteIds);
    if (!check.ok) return res.status(400).json({ message: check.error });

    // Guard tenant ownership on PATCH.
    if (isPatch) {
      const owned = await prisma.costPerson.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
      if (!owned) return res.status(404).json({ message: 'Person not found.' });
    }

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const person = isPatch
        ? await tx.costPerson.update({
            where: { id },
            data: { name, role, cost_type: costType as any, amount_pennies: amountPennies },
            select: { id: true },
          })
        : await tx.costPerson.create({
            data: { group_id: groupId, name, role, cost_type: costType as any, amount_pennies: amountPennies },
            select: { id: true },
          });
      await tx.costAllocation.deleteMany({ where: { cost_person_id: person.id } });
      await tx.costAllocation.createMany({
        data: check.rows.map((r) => ({
          group_id: groupId, site_id: r.siteId, percent: new Prisma.Decimal(r.percent), cost_person_id: person.id,
        })),
      });
      return person;
    });

    return res.status(isPatch ? 200 : 201).json({ id: result.id, message: isPatch ? 'Person updated.' : 'Person added.' });
  }

  // ---- DELETE: remove a person (allocations cascade) ----
  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : (req.body?.id as string) || '';
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const del = await prisma.costPerson.deleteMany({ where: { id, group_id: groupId } });
    if (del.count === 0) return res.status(404).json({ message: 'Person not found.' });
    return res.status(200).json({ message: 'Person removed.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
