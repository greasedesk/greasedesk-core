/**
 * File: pages/api/costs.ts
 * THE COSTS WRITE SURFACE — admin only, through the one guard.
 *
 * A rise is a NEW RATE with a date, never an edit to the amount: one auditable fact, the shape
 * EmploymentEvent uses for pay. An actual figure is an EDIT TO ONE INSTANCE, which regeneration
 * then leaves alone for ever (lib/costs::regenerate).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminApi } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { regenerate } from '@/lib/costs';

const monthStart = (iso: string) => {
  const d = new Date(`${String(iso).slice(0, 7)}-01T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  const groupId = vis.groupId as string;

  if (req.method === 'GET') {
    const costs = await prisma.cost.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true, name: true, cadence: true, charge: true, active_from: true, active_to: true, is_active: true,
        rates: { orderBy: { effective_from: 'asc' }, select: { id: true, effective_from: true, amount_pennies: true } },
        instances: { orderBy: { period_start: 'asc' },
          select: { id: true, period_start: true, period_end: true, due_on: true, amount_pennies: true, is_estimate: true, edited_at: true } },
        allocations: { select: { site_id: true, percent: true } },
      },
    });
    return res.status(200).json({ costs });
  }

  if (req.method === 'POST') {
    const { name, cadence, charge, activeFrom, amountPennies, siteId } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'A cost needs a name.' });
    if (!['monthly', 'quarterly', 'annual'].includes(cadence)) return res.status(400).json({ message: 'Cadence must be monthly, quarterly or annual.' });
    if (!['spread', 'falls'].includes(charge ?? 'spread')) return res.status(400).json({ message: 'Charge must be spread or falls.' });
    const from = monthStart(activeFrom);
    if (!from) return res.status(400).json({ message: 'Applies-from must be a month.' });
    const amount = Math.trunc(Number(amountPennies));
    // REFUSED, not corrected. A cost of nothing is a row that reads as a real cost and contributes
    // nothing — the shape that survives review because every screen looks fine.
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'An amount above zero is required.' });
    const site = await prisma.site.findFirst({ where: { id: String(siteId), group_id: groupId }, select: { id: true } });
    if (!site) return res.status(400).json({ message: 'Pick a location this cost belongs to.' });

    const cost = await prisma.cost.create({
      data: {
        group_id: groupId, name: String(name).trim(), cadence, charge: charge ?? 'spread', active_from: from,
        rates: { create: [{ effective_from: from, amount_pennies: amount }] },
        allocations: { create: [{ group_id: groupId, site_id: site.id, percent: 100 }] },
      },
      select: { id: true },
    });
    return res.status(200).json({ id: cost.id });
  }

  if (req.method === 'PATCH') {
    const { costId, instanceId, amountPennies, effectiveFrom, generateTo } = req.body ?? {};

    // ── AN ACTUAL FIGURE ARRIVED ────────────────────────────────────────────────────────────────
    if (instanceId) {
      const owned = await prisma.costInstance.findFirst({ where: { id: String(instanceId), cost: { group_id: groupId } }, select: { id: true } });
      if (!owned) return res.status(404).json({ message: 'Not found.' });
      const amount = Math.trunc(Number(amountPennies));
      if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message: 'Enter the amount.' });
      await prisma.costInstance.update({
        where: { id: owned.id },
        // is_estimate FALSE and edited_at SET together: they are one fact — a human typed this —
        // and regeneration reads edited_at to know never to overwrite it.
        data: { amount_pennies: amount, is_estimate: false, edited_at: new Date(), edited_by: (vis as any).userId ?? null },
      });
      return res.status(200).json({ ok: true });
    }

    const cost = await prisma.cost.findFirst({ where: { id: String(costId), group_id: groupId }, select: { id: true, active_from: true } });
    if (!cost) return res.status(404).json({ message: 'Not found.' });

    // ── A RISE: A NEW DATED RATE, THEN A REGENERATION ───────────────────────────────────────────
    if (amountPennies !== undefined) {
      const eff = monthStart(effectiveFrom);
      if (!eff) return res.status(400).json({ message: 'A change needs the month it applies from.' });
      const amount = Math.trunc(Number(amountPennies));
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'An amount above zero is required.' });
      await prisma.costRate.upsert({
        where: { cost_id_effective_from: { cost_id: cost.id, effective_from: eff } },
        create: { cost_id: cost.id, effective_from: eff, amount_pennies: amount },
        update: { amount_pennies: amount },
      });
    }

    const to = monthStart(generateTo) ?? new Date(Date.UTC(new Date().getUTCFullYear() + 1, new Date().getUTCMonth(), 1));
    const result = await regenerate(cost.id, cost.active_from, to);
    return res.status(200).json(result);
  }

  if (req.method === 'DELETE') {
    const { id } = req.body ?? {};
    const owned = await prisma.cost.findFirst({ where: { id: String(id), group_id: groupId }, select: { id: true } });
    if (!owned) return res.status(404).json({ message: 'Not found.' });
    await prisma.cost.delete({ where: { id: owned.id } });   // rates, instances and allocations cascade
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method not allowed.' });
}
