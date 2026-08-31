/**
 * File: lib/costs.ts
 * COSTS — A DEFINITION, A DATED RATE, AND GENERATED OCCURRENCES.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────────────────────────
 * The Overhead register had no dates at all: one amount, normalised to a month, multiplied by the
 * window's month count. Every month of every period carried today's figure, so a cost that started
 * in June was charged to January and a rent rise restated a closed year. Exactly the defect fixed
 * in the wage bill on 31 Aug 2026, one table across.
 *
 * The OCCURRENCE is what every reader reads. Nothing sums a definition.
 */
import { prisma } from '@/lib/db';
import { CostCadence, CostCharge } from '@prisma/client';

/** Months covered by one occurrence of each cadence. */
export const CADENCE_MONTHS: Record<CostCadence, number> = { monthly: 1, quarterly: 3, annual: 12 };

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

export type GeneratedInstance = {
  period_start: Date; period_end: Date; due_on: Date; amount_pennies: number;
};

/**
 * The rate effective for a period — the LAST rate whose effective_from is on or before the period
 * start. Same rule as valuesAtWindowEnd resolves pay, and for the same reason: what a garage was
 * charged in March must not move when the price changes in June.
 *
 * Rates must arrive ordered by effective_from ascending.
 */
export function rateFor(rates: { effective_from: Date; amount_pennies: number }[], periodStart: Date): number | null {
  let found: number | null = null;
  for (const r of rates) {
    if (r.effective_from.getTime() <= periodStart.getTime()) found = r.amount_pennies;
    else break;
  }
  // Before the first rate there is no answer — NOT zero. A cost with no rate yet is unknown, and a
  // zero would read as "this month was free".
  return found;
}

/**
 * Generate the occurrences a cost has in [from, to). Pure: the caller decides what to write.
 *
 * Periods are anchored on `active_from`, so a quarterly cost starting in February falls in
 * February, May, August, November — not on calendar quarters it has nothing to do with.
 */
export function generateInstances(
  cost: { cadence: CostCadence; active_from: Date; active_to: Date | null },
  rates: { effective_from: Date; amount_pennies: number }[],
  from: Date, to: Date,
): GeneratedInstance[] {
  const step = CADENCE_MONTHS[cost.cadence];
  const out: GeneratedInstance[] = [];
  let start = monthStart(cost.active_from);
  // Walk forward from the cost's own start so the phase is right, and keep what lands in the window.
  while (start.getTime() < to.getTime()) {
    const end = addMonths(start, step);
    const endsBeforeWindow = end.getTime() <= from.getTime();
    const afterActive = cost.active_to != null && start.getTime() >= cost.active_to.getTime();
    if (afterActive) break;
    if (!endsBeforeWindow) {
      const amount = rateFor(rates, start);
      if (amount != null) out.push({ period_start: start, period_end: end, due_on: start, amount_pennies: amount });
    }
    start = end;
  }
  return out;
}

/**
 * ── THE INVARIANT ───────────────────────────────────────────────────────────────────────────────
 * How much of one occurrence falls inside [from, to).
 *
 * SPREAD divides the occurrence evenly across the months it covers and counts the months that
 * overlap the window. FALLS counts the whole occurrence if its due date is inside the window and
 * nothing otherwise.
 *
 * Over a window containing the WHOLE occurrence the two are identical, by construction: spread
 * counts every month of it, falls counts it once. That is the property that makes the setting a
 * distribution rather than a different answer, and costs-gate pins it — if a year of a spread
 * annual and a year of a fallen annual ever differ, the setting is changing the figure.
 */
export function portionInWindow(
  inst: { period_start: Date; period_end: Date; due_on: Date; amount_pennies: number },
  charge: CostCharge, from: Date, to: Date,
): number {
  if (charge === 'falls') {
    return inst.due_on.getTime() >= from.getTime() && inst.due_on.getTime() < to.getTime() ? inst.amount_pennies : 0;
  }
  const months = Math.max(1, Math.round(
    (inst.period_end.getTime() - inst.period_start.getTime()) / (86_400_000 * 30.436875)));
  let covered = 0;
  for (let i = 0; i < months; i++) {
    const mFrom = addMonths(inst.period_start, i);
    const mTo = addMonths(inst.period_start, i + 1);
    if (mFrom.getTime() < to.getTime() && mTo.getTime() > from.getTime()) covered++;
  }
  // Rounded per month then summed, like the wage bill: a year must equal the months a garage can
  // add up on screen, which matters more than the penny that rounding once would save.
  return Math.round((inst.amount_pennies / months)) * covered;
}

export type CostsInWindow = {
  /** Total for the window, in pennies. */
  pennies: number;
  /** No cost is defined at all — the register is EMPTY, which is unknown, not nought. */
  empty: boolean;
  /** Instances counted that are still generated estimates rather than confirmed figures. */
  estimateCount: number;
  /** Instances counted in total. */
  instanceCount: number;
};

/**
 * THE READER. A sum over occurrences in the window — never a monthly rate times a month count.
 *
 * EMPTY IS NOT ZERO. A tenant with no costs defined has an UNKNOWN cost base, not a low one, and
 * the difference matters: on TMBS the overheads it replaces are 34% of the cost base, so reporting
 * zero would improve net profit by £11,175 over five months and look like good news.
 */
export async function costsInWindow(groupId: string, siteIds: string[], from: Date, to: Date): Promise<CostsInWindow> {
  const costs = await prisma.cost.findMany({
    where: { group_id: groupId, is_active: true },
    select: {
      id: true, cadence: true, charge: true, active_from: true, active_to: true,
      allocations: { where: { site_id: { in: siteIds } }, select: { percent: true } },
      instances: { where: { period_start: { lt: to } }, orderBy: { period_start: 'asc' },
        select: { period_start: true, period_end: true, due_on: true, amount_pennies: true, is_estimate: true } },
    },
  });
  if (!costs.length) return { pennies: 0, empty: true, estimateCount: 0, instanceCount: 0 };

  let pennies = 0, estimateCount = 0, instanceCount = 0;
  for (const c of costs) {
    const share = c.allocations.reduce((s, a) => s + Number(a.percent), 0) / 100;
    if (share === 0) continue;
    for (const inst of c.instances) {
      const portion = portionInWindow(inst, c.charge, from, to);
      if (portion === 0) continue;
      instanceCount++;
      if (inst.is_estimate) estimateCount++;
      pennies += Math.round(portion * share);
    }
  }
  return { pennies, empty: false, estimateCount, instanceCount };
}

/**
 * REGENERATION NEVER TOUCHES AN EDITED INSTANCE.
 *
 * `edited_at` is the flag and the only thing this looks at. Once somebody has typed the figure from
 * a real bill, overwriting it would silently restate a month the garage has already read — the same
 * rule as reconcile-never-append in the setup wizard.
 *
 * Returns what it did, so a caller can say so rather than claim a silent success.
 */
export async function regenerate(costId: string, from: Date, to: Date): Promise<{ written: number; skippedEdited: number }> {
  const cost = await prisma.cost.findUnique({
    where: { id: costId },
    select: { cadence: true, active_from: true, active_to: true,
      rates: { orderBy: { effective_from: 'asc' }, select: { effective_from: true, amount_pennies: true } },
      instances: { select: { period_start: true, edited_at: true } } },
  });
  if (!cost) throw new Error('Cost not found.');
  const edited = new Set(cost.instances.filter((i) => i.edited_at != null).map((i) => i.period_start.getTime()));
  const wanted = generateInstances(cost, cost.rates, from, to);

  let written = 0, skippedEdited = 0;
  for (const w of wanted) {
    if (edited.has(w.period_start.getTime())) { skippedEdited++; continue; }
    await prisma.costInstance.upsert({
      where: { cost_id_period_start: { cost_id: costId, period_start: w.period_start } },
      create: { cost_id: costId, ...w, is_estimate: true },
      update: { period_end: w.period_end, due_on: w.due_on, amount_pennies: w.amount_pennies },
    });
    written++;
  }
  return { written, skippedEdited };
}
