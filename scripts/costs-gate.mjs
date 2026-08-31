/**
 * File: scripts/costs-gate.mjs
 * @gate-timeout: 240
 * @gate-requires: db
 *
 * A COST LANDS IN THE MONTHS IT APPLIES TO, AND THE CHARGE RULE ONLY DISTRIBUTES IT.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────────────────────────
 * The Overhead register had no dates: one amount, normalised to a month, multiplied by the window's
 * month count. Every month of every period carried today's figure — a cost starting in June was
 * charged to January, and a rent rise restated a closed year. The same defect fixed in the wage
 * bill hours earlier, one table across.
 *
 * ── THE INVARIANT THIS EXISTS FOR ───────────────────────────────────────────────────────────────
 * Section 1. Twelve months of a SPREAD annual and twelve months of a FALLEN annual must total the
 * same. If they ever differ, the per-cost setting is changing the ANSWER rather than its
 * DISTRIBUTION — which would make a garage's yearly cost depend on a display preference.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const m = (p) => p == null ? '—' : `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const d = (s) => new Date(`${s}T00:00:00.000Z`);
const MARK = 'ZZCOST';

let prisma, madeCosts = [];
try {
  prisma = await gatePrisma();
  const C = await import('../lib/costs.ts');

  // ── 1. THE INVARIANT: THE SETTING DISTRIBUTES, IT DOES NOT CHANGE ─────────────────────────────
  console.log('\n— a year costs the same either way —');
  const ANNUAL = { cadence: 'annual', active_from: d('2026-01-01'), active_to: null };
  const rates = [{ effective_from: d('2026-01-01'), amount_pennies: 120_000 }];   // £1,200/yr
  const year = [d('2026-01-01'), d('2027-01-01')];
  const insts = C.generateInstances(ANNUAL, rates, ...year);
  check('one occurrence in the year', insts.length === 1, `${insts.length}`);
  const spread = insts.reduce((a, i) => a + C.portionInWindow(i, 'spread', ...year), 0);
  const falls = insts.reduce((a, i) => a + C.portionInWindow(i, 'falls', ...year), 0);
  check('twelve months of a SPREAD annual equals twelve months of a FALLEN annual',
    spread === falls && spread === 120_000, `spread ${m(spread)} vs falls ${m(falls)}`);

  // AND THE DISTRIBUTION IS REAL — the two must DIFFER inside the year, or the check above passes
  // because the setting does nothing at all.
  const jan = [d('2026-01-01'), d('2026-02-01')], jun = [d('2026-06-01'), d('2026-07-01')];
  const spreadJan = C.portionInWindow(insts[0], 'spread', ...jan);
  const fallsJan = C.portionInWindow(insts[0], 'falls', ...jan);
  const spreadJun = C.portionInWindow(insts[0], 'spread', ...jun);
  const fallsJun = C.portionInWindow(insts[0], 'falls', ...jun);
  check('  …while inside the year they differ, or the setting does nothing',
    spreadJan === 10_000 && fallsJan === 120_000 && spreadJun === 10_000 && fallsJun === 0,
    `Jan spread ${m(spreadJan)} / falls ${m(fallsJan)}; Jun spread ${m(spreadJun)} / falls ${m(fallsJun)}`);

  // Quarterly, for a cadence whose phase is not the calendar's.
  const Q = { cadence: 'quarterly', active_from: d('2026-02-01'), active_to: null };
  const qi = C.generateInstances(Q, [{ effective_from: d('2026-02-01'), amount_pennies: 30_000 }], d('2026-02-01'), d('2027-02-01'));
  check('a quarterly cost falls on ITS OWN phase, not the calendar’s', qi.length === 4
    && qi.map((i) => i.period_start.toISOString().slice(5, 7)).join(',') === '02,05,08,11',
    qi.map((i) => i.period_start.toISOString().slice(0, 7)).join(' '));
  const qSpread = qi.reduce((a, i) => a + C.portionInWindow(i, 'spread', d('2026-02-01'), d('2027-02-01')), 0);
  const qFalls = qi.reduce((a, i) => a + C.portionInWindow(i, 'falls', d('2026-02-01'), d('2027-02-01')), 0);
  check('  …and a year of it totals the same either way', qSpread === qFalls, `${m(qSpread)} vs ${m(qFalls)}`);

  // ── 2. A COST IS NOT CHARGED BEFORE IT STARTS ─────────────────────────────────────────────────
  console.log('\n— dates, which the register it replaces did not have —');
  const JUNE = { cadence: 'monthly', active_from: d('2026-06-01'), active_to: null };
  const jr = [{ effective_from: d('2026-06-01'), amount_pennies: 50_000 }];
  const gen = C.generateInstances(JUNE, jr, d('2026-01-01'), d('2026-09-01'));
  check('a cost starting in June is not charged to January', gen.length === 3
    && gen[0].period_start.toISOString().slice(0, 7) === '2026-06',
    gen.map((i) => i.period_start.toISOString().slice(0, 7)).join(' ') || 'none');
  const ended = C.generateInstances({ cadence: 'monthly', active_from: d('2026-01-01'), active_to: d('2026-03-01') },
    [{ effective_from: d('2026-01-01'), amount_pennies: 10_000 }], d('2026-01-01'), d('2026-09-01'));
  check('  …nor after it ends', ended.length === 2, ended.map((i) => i.period_start.toISOString().slice(0, 7)).join(' '));

  // ── 3. A RISE IS DATED, AND DOES NOT RESTATE THE PAST ─────────────────────────────────────────
  const risen = C.generateInstances({ cadence: 'monthly', active_from: d('2026-01-01'), active_to: null },
    [{ effective_from: d('2026-01-01'), amount_pennies: 100_000 }, { effective_from: d('2026-06-01'), amount_pennies: 120_000 }],
    d('2026-01-01'), d('2026-09-01'));
  check('a rent rise from June leaves January alone',
    risen[0].amount_pennies === 100_000 && risen[5].amount_pennies === 120_000,
    `Jan ${m(risen[0].amount_pennies)}, Jun ${m(risen[5].amount_pennies)}`);
  check('  …and a period before ANY rate has no figure, not a zero',
    C.rateFor([{ effective_from: d('2026-06-01'), amount_pennies: 1 }], d('2026-01-01')) === null,
    'zero would read as a month that cost nothing');

  // ── 4. REGENERATION NEVER TOUCHES AN EDITED INSTANCE ──────────────────────────────────────────
  // On the gate tenant, with throwaway rows torn down by their own identifier.
  console.log('\n— an edited figure survives regeneration —');
  const cost = await prisma.cost.create({
    data: { group_id: ZZ_GROUP, name: `${MARK} Rent`, cadence: 'monthly', charge: 'spread',
      active_from: d('2026-01-01'),
      rates: { create: [{ effective_from: d('2026-01-01'), amount_pennies: 100_000 }] } },
    select: { id: true } });
  madeCosts.push(cost.id);
  await C.regenerate(cost.id, d('2026-01-01'), d('2026-04-01'));
  const feb = await prisma.costInstance.findFirst({ where: { cost_id: cost.id, period_start: d('2026-02-01') }, select: { id: true, amount_pennies: true } });
  check('generation writes an instance per month', !!feb && feb.amount_pennies === 100_000, m(feb?.amount_pennies));

  // The real bill arrived and somebody typed it.
  await prisma.costInstance.update({ where: { id: feb.id }, data: { amount_pennies: 137_50, is_estimate: false, edited_at: new Date(), edited_by: 'gate' } });
  const again = await C.regenerate(cost.id, d('2026-01-01'), d('2026-04-01'));
  const febAfter = await prisma.costInstance.findUnique({ where: { id: feb.id }, select: { amount_pennies: true, is_estimate: true } });
  check('regeneration leaves the edited month exactly as typed',
    febAfter.amount_pennies === 137_50 && febAfter.is_estimate === false,
    `${m(febAfter.amount_pennies)}, estimate=${febAfter.is_estimate} — overwriting would restate a month already read`);
  check('  …and says how many it skipped rather than claiming a silent success',
    again.skippedEdited === 1 && again.written === 2, JSON.stringify(again));

  // ── 5. THE READER, AND EMPTY IS NOT ZERO ──────────────────────────────────────────────────────
  console.log('\n— the reader —');
  const sites = (await prisma.site.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } })).map((s) => s.id);
  await prisma.costAllocation.create({ data: { group_id: ZZ_GROUP, cost_id: cost.id, site_id: sites[0], percent: 100 } });
  const q1 = await C.costsInWindow(ZZ_GROUP, sites, d('2026-01-01'), d('2026-04-01'));
  check('the window sums its instances, edited figure included',
    q1.pennies === 100_000 + 137_50 + 100_000, `${m(q1.pennies)} — Jan £1,000 + Feb £137.50 + Mar £1,000`);
  check('  …and reports how many are still estimates', q1.estimateCount === 2 && q1.instanceCount === 3,
    `${q1.estimateCount} of ${q1.instanceCount} still estimates`);
  const q0 = await C.costsInWindow(ZZ_GROUP, sites, d('2025-01-01'), d('2025-04-01'));
  check('a window before the cost existed sums to nothing, and is NOT flagged empty',
    q0.pennies === 0 && q0.empty === false, 'the register exists; this window simply has no instances');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  if (prisma && madeCosts.length) {
    await prisma.costAllocation.deleteMany({ where: { cost_id: { in: madeCosts } } }).catch(() => {});
    await prisma.costInstance.deleteMany({ where: { cost_id: { in: madeCosts } } }).catch(() => {});
    await prisma.costRate.deleteMany({ where: { cost_id: { in: madeCosts } } }).catch(() => {});
    await prisma.cost.deleteMany({ where: { id: { in: madeCosts } } }).catch(() => {});
    const left = await prisma.cost.count({ where: { group_id: ZZ_GROUP, name: { startsWith: MARK } } }).catch(() => -1);
    check('teardown removed every fixture cost (ZZ only)', left === 0, `${left} left`);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
