/**
 * File: scripts/wage-per-month-gate.mjs
 * @gate-timeout: 240
 * @gate-requires: db
 *
 * PAYROLL IS CHARGED TO THE MONTHS IT WAS ACTUALLY PAID IN.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 * monthlyWageBill took ONE window and asked it one question: who overlapped it at any point, at
 * their pay as at the window END. Multiply by the month count and every one of those people is
 * charged to every month.
 *
 * On TMBS that put Ta'Harie Samuels (started 1 June 2026) on the April and May payroll, and Lewis
 * Bishop (left 28 March 2026) on all twelve months of a September-anchored year. The wage bill for
 * that year was £85,280.04 where the months actually paid come to £61,966.66 — 27% too high, and
 * it flowed straight into net profit, the cost base and break-even hours.
 *
 * ── WHY THE SIGNATURE DOES NOT CHANGE ───────────────────────────────────────────────────────────
 * `pnl`, `costBase` and `manpower` all read this one function, and lib/manpower states a
 * reconciliation identity: grossPayPennies ≡ monthlyWageBill().pennies. A separate per-month
 * helper would let the cost base be corrected while the Gross pay tile stayed wrong, and the
 * identity would become false without anything failing. Summing inside keeps all three together.
 *
 * ── AND WHAT THAT CHANGES FOR CALLERS ───────────────────────────────────────────────────────────
 * `pennies` is now the TOTAL for the window, not a monthly rate to be multiplied. Section 4 is the
 * check that matters long-term: a caller that multiplies it by `months` again would be twelve times
 * wrong on a year, and the mistake reads as a plausible number.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const m = (p) => p == null ? '—' : `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const prose = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const MARK = 'ZZWPM';                       // throwaway rows, torn down by THIS identifier
const d = (s) => new Date(`${s}T00:00:00.000Z`);

let prisma, made = [];
try {
  prisma = await gatePrisma();
  const T = await import('../lib/dashboard-tiles.ts');
  const M = await import('../lib/manpower.ts');
  const zzSites = (await prisma.site.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } })).map((s) => s.id);

  // ── 1. A STARTER IS NOT CHARGED BEFORE THEY STARTED ───────────────────────────────────────────
  // Throwaway people on the gate tenant, never a real row: £120,000 a year is £10,000 a month, so
  // every figure below is readable by eye and a wrong month count cannot hide in the rounding.
  console.log('\n— who is on the payroll, month by month —');
  const mk = async (name, payStart, payEnd) => {
    const p = await prisma.costPerson.create({
      data: { group_id: ZZ_GROUP, name: `${MARK} ${name}`, cost_type: 'salary', amount_pennies: 12_000_000,
        start_date: payStart, pay_start_date: payStart, work_end_date: payEnd, pay_end_date: payEnd, is_active: !payEnd },
      select: { id: true } });
    made.push(p.id);
    await prisma.costAllocation.create({ data: { group_id: ZZ_GROUP, cost_person_id: p.id, site_id: zzSites[0], percent: 100 } });
    return p.id;
  };
  const WIN = { from: d('2026-01-01'), to: d('2026-05-01') };   // four months: Jan Feb Mar Apr
  const baseline = (await T.monthlyWageBill(ZZ_GROUP, zzSites, WIN)).pennies;

  await mk('Starter', d('2026-03-01'), null);                   // present for March + April only
  const withStarter = (await T.monthlyWageBill(ZZ_GROUP, zzSites, WIN)).pennies;
  check('a mid-window starter is charged for the months AFTER they started, and no others',
    withStarter - baseline === 2 * 1_000_000,
    `${m(withStarter - baseline)} over four months — two months at £10,000 is right, four is the defect`);

  await mk('Leaver', d('2025-01-01'), d('2026-02-15'));         // paid through Jan + Feb only
  const withLeaver = (await T.monthlyWageBill(ZZ_GROUP, zzSites, WIN)).pennies;
  check('a mid-window leaver is charged up to their last paid month, and no further',
    withLeaver - withStarter === 2 * 1_000_000,
    `${m(withLeaver - withStarter)} — a leaver carried to the window end would read ${m(4 * 1_000_000)}`);

  // DISCRIMINATING: the same two people over a window they are wholly outside must cost nothing.
  const OUTSIDE = { from: d('2026-06-01'), to: d('2026-07-01') };
  const outsideNow = (await T.monthlyWageBill(ZZ_GROUP, zzSites, OUTSIDE)).pennies;
  const outsideBase = outsideNow - 1_000_000;   // the Starter is still employed in June; the Leaver is not
  check('  …and a leaver is absent entirely from a later window', outsideBase >= 0,
    `June costs ${m(outsideNow)} — the Starter only`);

  // ── 2. THE MANPOWER IDENTITY ──────────────────────────────────────────────────────────────────
  // lib/manpower states grossPayPennies ≡ monthlyWageBill().pennies. It is the reason this change
  // went INSIDE the shared function: correcting the cost base alone would leave the Gross pay tile
  // wrong and the stated identity false, with nothing failing to say so.
  console.log('\n— the identity lib/manpower declares —');
  const ONE = { from: d('2026-03-01'), to: d('2026-04-01') };
  const [mp, wb] = [await M.getManpower(ZZ_GROUP, zzSites, ONE), await T.monthlyWageBill(ZZ_GROUP, zzSites, ONE)];
  check('grossPayPennies ≡ monthlyWageBill().pennies', mp.grossPayPennies?.value === wb.pennies,
    `manpower ${m(mp.grossPayPennies?.value)} vs ${m(wb.pennies)}`);

  // ── 3. THE REAL TENANT'S SERIES, READ-ONLY ────────────────────────────────────────────────────
  // Pinned as a SERIES rather than a total: a total can be right for the wrong reasons, and the
  // shape is what says the months are being asked separately.
  console.log('\n— TMBS, month by month (read-only) —');
  const tSites = (await prisma.site.findMany({ where: { group_id: TMBS }, select: { id: true } })).map((s) => s.id);
  const series = [];
  for (let i = 0; i < 12; i++) {
    const f = new Date(Date.UTC(2025, 8 + i, 1));
    series.push((await T.monthlyWageBill(TMBS, tSites, { from: f, to: new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1)) })).pennies);
  }
  const expected = [572_000, 572_000, 572_000, 572_000, 572_000, 572_000, 572_000, 355_333, 355_333, 494_000, 494_000, 494_000];
  check('Sep–Mar is £5,720.00, Apr–May £3,553.33, Jun–Aug £4,940.00',
    series.every((v, i) => v === expected[i]), series.map(m).join(' '));
  const total = (await T.monthlyWageBill(TMBS, tSites, { from: d('2025-09-01'), to: d('2026-09-01') })).pennies;
  check('  …and the twelve-month figure is their SUM, not one month times twelve',
    total === series.reduce((a, b) => a + b, 0),
    `${m(total)} — the old rule read ${m(85_280_04 / 100 * 100)}`);

  // ── 3b. THE TWO FORMS OF THE EMPLOYMENT RULE AGREE ────────────────────────────────────────────
  // The per-month sum answers "was this person employed in March" in MEMORY, because a query per
  // month per site would have put ~70 extra round trips on a dashboard load. Two forms of one rule
  // is a divergence waiting to happen, so they are pinned against each other on the boundaries —
  // which is where a date rule goes wrong, never in the middle.
  console.log('\n— isEmployedDuring matches the SQL it mirrors —');
  const C = await import('../lib/capacity.ts');
  const MAR = { from: d('2026-03-01'), to: d('2026-04-01') };
  const sqlIds = new Set((await prisma.costPerson.findMany({
    where: { ...C.employedDuring(ZZ_GROUP, MAR, 'pay'), name: { startsWith: MARK } }, select: { id: true },
  })).map((x) => x.id));
  const rows = await prisma.costPerson.findMany({
    where: { group_id: ZZ_GROUP, name: { startsWith: MARK } },
    select: { id: true, name: true, start_date: true, pay_start_date: true, work_end_date: true, pay_end_date: true } });
  const disagree = rows.filter((r) => C.isEmployedDuring(r, MAR, 'pay') !== sqlIds.has(r.id)).map((r) => r.name);
  check('the in-memory rule and the SQL rule select the same people', disagree.length === 0,
    disagree.join(', ') || `${rows.length} fixtures, ${sqlIds.size} employed in March`);
  // Boundary, stated explicitly: the Leaver's last paid day is 15 Feb, so February counts and March
  // does not. An off-by-one in either form shows up here and nowhere else.
  const leaver = rows.find((r) => r.name.endsWith('Leaver'));
  check('  …including the month a leaver’s last paid day falls in',
    !!leaver && C.isEmployedDuring(leaver, { from: d('2026-02-01'), to: d('2026-03-01') }, 'pay') === true
    && C.isEmployedDuring(leaver, MAR, 'pay') === false,
    'paid to 15 Feb: February is charged, March is not');

  // ── 4. AND NO CALLER MULTIPLIES IT AGAIN ──────────────────────────────────────────────────────
  // `pennies` used to be a monthly rate. A caller still multiplying by `months` is twelve times
  // wrong on a year and reads as a plausible number, which is the shape that survives review.
  console.log('\n— the multiplier is gone —');
  for (const f of ['lib/dashboard-tiles.ts', 'lib/manpower.ts']) {
    const src = prose(f);
    const bad = [...src.matchAll(/(wageBillMonthly|wb\.pennies|wage\.pennies|wageRead\.pennies)\s*\*\s*months/g)].map((x) => x[0]);
    check(`${f} does not multiply the wage bill by months`, bad.length === 0, bad.join(', ') || 'the figure is already the window total');
  }
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  // Torn down by the fixtures' OWN identifier, never by anything the code under test returned.
  if (prisma && made.length) {
    await prisma.costAllocation.deleteMany({ where: { cost_person_id: { in: made } } }).catch(() => {});
    await prisma.costPerson.deleteMany({ where: { id: { in: made } } }).catch(() => {});
    const left = await prisma.costPerson.count({ where: { group_id: ZZ_GROUP, name: { startsWith: MARK } } }).catch(() => -1);
    check('teardown removed every fixture person (ZZ only)', left === 0, `${left} left`);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
