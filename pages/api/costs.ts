/**
 * File: pages/api/costs.ts
 * THE COSTS WRITE SURFACE — admin only, through the one guard.
 *
 * A rise is a NEW RATE with a date, never an edit to the amount: one auditable fact, the shape
 * EmploymentEvent uses for pay. An actual figure is an EDIT TO ONE INSTANCE, which regeneration
 * then leaves alone for ever (lib/costs::regenerate).
 *
 * CREATING A COST GENERATES ITS INSTANCES. A cost with none reports £0.00 rather than withholding,
 * which is worse than never entering it — see the note on the POST branch.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminApi } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { regenerate } from '@/lib/costs';
import { writeAudit } from '@/lib/audit';

const monthStart = (iso: string) => {
  const d = new Date(`${String(iso).slice(0, 7)}-01T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * How far ahead instances are generated when the caller does not say.
 *
 * ONE DEFINITION, because POST and PATCH both need it and a create that generated a different span
 * from the next regenerate would leave a cost whose horizon depended on which route last touched it.
 */
const defaultHorizon = () =>
  new Date(Date.UTC(new Date().getUTCFullYear() + 1, new Date().getUTCMonth(), 1));

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
    // ── AND ITS INSTANCES, IN THE SAME REQUEST ────────────────────────────────────────────────
    // This used to return here, leaving a cost with a rate, an allocation and NO occurrences. That
    // is not a half-finished cost, it is a wrong figure: costsInWindow withholds the cost base only
    // while there are no cost ROWS, so the first ungenerated cost flips a tenant from "unknown" to
    // a confident £0.00 — worth £11,175 of imaginary profit on TMBS by lib/costs's own reckoning.
    //
    // Generation was a second step behind a Generate button, so the wrong state was one forgotten
    // click away and looked exactly like a correct one. A caller that gets a 200 now has a cost
    // that reports what it costs.
    //
    // Safe to run here: regenerate skips instances a person has edited, and there are none on a
    // cost created a line ago. It stays available on PATCH for extending the horizon and for
    // re-running after a rate change.
    const generated = await regenerate(cost.id, from, defaultHorizon());
    return res.status(200).json({ id: cost.id, ...generated });
  }

  if (req.method === 'PATCH') {
    const { costId, instanceId, amountPennies, effectiveFrom, generateTo, confirmAll } = req.body ?? {};

    // ── AN ACTUAL FIGURE ARRIVED ────────────────────────────────────────────────────────────────
    if (instanceId) {
      const owned = await prisma.costInstance.findFirst({
        where: { id: String(instanceId), cost: { group_id: groupId } },
        select: { id: true, period_start: true, amount_pennies: true, is_estimate: true,
          cost: { select: { id: true, name: true } } },
      });
      if (!owned) return res.status(404).json({ message: 'Not found.' });
      const amount = Math.trunc(Number(amountPennies));
      // ZERO IS REFUSED, by name, as it is two branches below. This guarded `< 0`, so an EMPTY box
      // — the obvious gesture for "this month was what we said" — sent Number('') → 0 and wrote
      // £0.00 marked CONFIRMED with edited_at set, which regeneration then refuses to correct for
      // ever. A cost of nothing is a row that reads as a real cost and contributes nothing.
      // Confirming at the estimate is what `confirmAll` below is for.
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ message: 'An amount above zero is required. To confirm this month at the figure already shown, use “Confirm at the estimate”.' });
      }
      const previousPennies = owned.amount_pennies;
      await prisma.$transaction(async (tx) => {
        await tx.costInstance.update({
          where: { id: owned.id },
          // is_estimate FALSE and edited_at SET together: they are one fact — a human typed this —
          // and regeneration reads edited_at to know never to overwrite it.
          data: { amount_pennies: amount, is_estimate: false, edited_at: new Date(), edited_by: (vis as any).userId ?? null },
        });
        // RECORDED. This was the cheap, unaudited way to change a closed month's cost.
        await writeAudit(tx, {
          groupId, userId: (vis as any).userId ?? null, entity: 'cost', entityId: owned.cost.id,
          action: 'cost.instance_recorded',
          diff: { costName: owned.cost.name, period: owned.period_start.toISOString().slice(0, 10),
            fromPennies: previousPennies, toPennies: amount, wasEstimate: owned.is_estimate },
        });
      });
      return res.status(200).json({ ok: true });
    }

    const cost = await prisma.cost.findFirst({ where: { id: String(costId), group_id: groupId }, select: { id: true, name: true, active_from: true } });
    if (!cost) return res.status(404).json({ message: 'Not found.' });

    // ── CONFIRM EVERY FALLEN-DUE MONTH AT ITS ESTIMATE ─────────────────────────────────────────
    // A rent that does not vary is the case this exists for. It changes NO figure — costsInWindow
    // sums amount_pennies whatever is_estimate says — so its whole value is the audit row and the
    // edited_at lock. It is a record of checking, not a restatement.
    //
    // Placed above the rate and regenerate branches deliberately: a body carrying costId and no
    // amountPennies used to fall through to a regeneration, so this flag would have silently
    // regenerated the cost instead of confirming it.
    if (confirmAll === true) {
      const now = new Date();
      const instances = await prisma.costInstance.findMany({
        where: { cost_id: cost.id },
        select: { id: true, period_start: true, amount_pennies: true, is_estimate: true, due_on: true },
        orderBy: { period_start: 'asc' },
      });
      // DUE_ON, not period_end. Rent falls due on the 1st; on the 6th it has genuinely arrived, and
      // waiting for the month to close would refuse a bill already paid. Confirming a bill that has
      // not fallen due is a forecast wearing the wrong label.
      const inScope = instances.filter((i) => i.due_on <= now);
      const skipped = inScope.filter((i) => !i.is_estimate).length;
      const toConfirm = inScope.filter((i) => i.is_estimate);
      // ONE ZERO REFUSES THE WHOLE ACT. Stamping "confirmed" across a figure that is obviously not
      // one is the thing this control must never do, and a partial pass would be worse than none.
      const zeros = inScope.filter((i) => i.amount_pennies <= 0);
      if (zeros.length) {
        return res.status(400).json({
          message: `${zeros.length === 1 ? 'One month is' : `${zeros.length} months are`} showing nothing at all (${zeros.map((z) => z.period_start.toISOString().slice(0, 7)).join(', ')}). Put the real figures in first — confirming a cost of nothing would hide it.`,
        });
      }
      if (!toConfirm.length) return res.status(200).json({ confirmed: 0, skipped });

      const totalPennies = toConfirm.reduce((t, i) => t + i.amount_pennies, 0);
      const firstPeriod = toConfirm[0].period_start.toISOString().slice(0, 10);
      const lastPeriod = toConfirm[toConfirm.length - 1].period_start.toISOString().slice(0, 10);
      await prisma.$transaction(async (tx) => {
        await tx.costInstance.updateMany({
          where: { id: { in: toConfirm.map((i) => i.id) } },
          // The same three fields the per-row save writes, for the same reason.
          data: { is_estimate: false, edited_at: new Date(), edited_by: (vis as any).userId ?? null },
        });
        // ONE ROW FOR THE ACT. Twelve rows would bury the one fact worth reading.
        await writeAudit(tx, {
          groupId, userId: (vis as any).userId ?? null, entity: 'cost', entityId: cost.id,
          action: 'cost.instances_confirmed',
          diff: { costName: cost.name, confirmed: toConfirm.length, skipped, firstPeriod, lastPeriod, totalPennies },
        });
      });
      return res.status(200).json({ confirmed: toConfirm.length, skipped, firstPeriod, lastPeriod, totalPennies });
    }

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

    const to = monthStart(generateTo) ?? defaultHorizon();
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
