/**
 * File: scripts/reporting-anchor-gate.mjs
 * @gate-timeout: 300
 * @gate-requires: server, db
 *
 * ONE ANCHOR, AND EVERY TILE BEHIND IT.
 *
 * ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 * Clipping was opt-in per compute: costBase, utilisation and capacity each called clipToData and
 * the other four did not. Nothing made that visible, so net profit charged TWELVE months of payroll
 * against FIVE months of trading and sat beside a five-month cost base:
 *
 *     Net profit  −£58,043.76        Fixed costs  £35,875.05
 *
 * Neither figure is wrong alone. The pair is incoherent, and on one anchor TMBS reads −£58,043.76
 * while on another it reads +£18,181.35 — the same data, the same period, a different frame.
 *
 * ── WHAT MAKES IT STAY FIXED ────────────────────────────────────────────────────────────────────
 * The clip moves to ONE place, before any compute runs, so a new tile cannot forget it: clipping
 * becomes opt-OUT, and an opt-out has to be written down. Section 4 is the check that matters
 * long-term — it fails if a compute starts clipping for itself again.
 *
 * ── WHY SECTION 1 ASKS ABOUT EVERY TENANT AND ABOUT THE COLUMN DEFAULT ──────────────────────────
 * Because asking about one row did not work. Section 1 used to check that the GATE TENANT's anchor
 * sat on the 1st, which is a value, not a rule — and a clause pinned to a value goes green as soon
 * as somebody fixes that value. It did exactly that on 2026-11-05 while four other tenants on this
 * database and two on production, one of them a real garage, were still mid-month. The rule is now
 * asked of every row AND of the column default, so the symptom and the cause each have a clause.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, serverReady, ZZ_GROUP, gateOrigin } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readMonth } = await import('./_month-select.mjs');
const { readFileSync } = await import('node:fs');
const { chromium } = await import('playwright-core');

const BASE = gateOrigin();
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const m = (p) => p == null ? '—' : `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let browser, prisma, original = undefined, seededCostId = null;
try {
  prisma = await gatePrisma();

  // ── 1. THE COLUMN ─────────────────────────────────────────────────────────────────────────────
  console.log('\n— the anchor is a column, not an inference —');
  const col = await prisma.$queryRawUnsafe(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'Group' AND column_name = 'reporting_start_date'`);
  check('Group.reporting_start_date exists', col.length === 1, JSON.stringify(col[0] ?? null));
  check('  …and is NOT NULL', col[0]?.is_nullable === 'NO',
    'nullable here could only mean a writer forgot; the constraint is what makes that loud');

  const zz = await prisma.group.findUnique({ where: { id: ZZ_GROUP }, select: { reporting_start_date: true } }).catch(() => null);
  original = zz?.reporting_start_date;
  check('the gate tenant is backfilled', !!original, original ? original.toISOString().slice(0, 10) : 'null');
  /**
   * ── EVERY TENANT, NOT THE GATE TENANT ─────────────────────────────────────────────────────────
   * This asked only whether ZZ's own anchor sat on the 1st, and that is why it was useless. On
   * 2026-11-05 ZZ was found on 26 October at 13:58:49; normalising that ONE ROW turned the clause
   * green while FOUR other tenants on the same database were still mid-month, and two on
   * production, one of them a real garage. The clause had pinned a value where the rule belonged,
   * so fixing the symptom silenced the only thing that could have reported the cause.
   *
   * The cause was DEFAULT CURRENT_TIMESTAMP: the 20260830120000 backfill normalised through
   * date_trunc and then left new tenants on the raw signup instant, so the canonical day held for
   * every tenant alive on 30 August 2026 and for none created after it.
   *
   * TIME-OF-DAY IS PART OF THE RULE, not a refinement of it. Wizzy Wheels was on the 1st at
   * 19:15:04 — day-1 and wrong — because it happened to sign up on the 1st. A day-only check calls
   * that clean, and it still takes 19 hours out of the tenant’s own first reported month.
   *
   * AND THE POPULATION IS ASSERTED FIRST. "every tenant" over zero tenants is a positive report of
   * safety about nothing, which on a gate database that gets purged is a live possibility.
   */
  const anchors = await prisma.group.findMany({ select: { ref: true, reporting_start_date: true } });
  check('there are tenants on this database to check at all', anchors.length > 0, `${anchors.length} groups`);
  const canonical = (a) => a.getUTCDate() === 1 && a.getUTCHours() === 0 && a.getUTCMinutes() === 0
    && a.getUTCSeconds() === 0 && a.getUTCMilliseconds() === 0;
  const offDay = anchors.filter((g) => !canonical(g.reporting_start_date));
  check('  …and EVERY one of their anchors is the 1st at 00:00', offDay.length === 0,
    offDay.length ? offDay.map((g) => `${g.ref}=${g.reporting_start_date.toISOString()}`).join(', ')
      : `all ${anchors.length} on the first of a month at midnight`);
  /**
   * THE CAUSE, ASKED DIRECTLY. The clause above is about rows that exist; this one is about rows
   * that have not been created yet, and it is the one that stays true without a backfill. A gate
   * that only checks stored values goes green the moment somebody fixes the data and says nothing
   * at all until the next tenant signs up. See 20261105120000_reporting_anchor_default_month for
   * why the text is spelled exactly this way and not with a ::timestamp(3) cast.
   */
  const DEFAULT_WANTED = "date_trunc('month'::text, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text))";
  check('  …and the column DEFAULT normalises, so a new tenant cannot arrive off it',
    (col[0]?.column_default ?? '') === DEFAULT_WANTED, col[0]?.column_default ?? '(no default)');

  // ── 2. THE CLIP IS A FUNCTION, TESTABLE WITHOUT A DASHBOARD ───────────────────────────────────
  console.log('\n— clipSpanToAnchor —');
  const A = await import('../lib/reporting-anchor.ts').catch((e) => ({ __err: describeError(e) }));
  check('lib/reporting-anchor exports clipSpanToAnchor', typeof A.clipSpanToAnchor === 'function', A.__err ?? '');
  if (typeof A.clipSpanToAnchor === 'function') {
    const d = (s) => new Date(`${s}T00:00:00.000Z`);
    const inside = A.clipSpanToAnchor(d('2026-04-01'), d('2026-09-01'), d('2026-01-01'));
    check('a window inside the anchor is untouched', !inside.clipped && !inside.empty && inside.months === 5, JSON.stringify(inside.months));
    const over = A.clipSpanToAnchor(d('2025-09-01'), d('2026-09-01'), d('2026-04-01'));
    check('a window starting before it is moved forward', over.clipped && over.from.toISOString().slice(0, 10) === '2026-04-01',
      over.from.toISOString().slice(0, 10));
    // The trap one layer down: clipping `from` without recomputing `months` bills twelve months of
    // payroll against a five-month window — the window looks right while the total is 2.4x too big.
    check('  …and MONTHS moves with it', over.months === 5, `months=${over.months}`);
    const before = A.clipSpanToAnchor(d('2024-01-01'), d('2024-06-01'), d('2026-04-01'));
    check('a window entirely before it is EMPTY, not zero', before.empty === true,
      'zeros read as findings; an unlived period has no figure at all');
  }

  // ── 3. THE FIGURES RECONCILE ON ANY ANCHOR ────────────────────────────────────────────────────
  // The whole point, and asserted on the REAL tenant's data rather than a fixture: net profit's
  // fixed costs and the fixed-costs tile are the same money and must be the same number.
  console.log('\n— net profit and fixed costs are the same money —');
  const T = await import('../lib/dashboard-tiles.ts');
  const P = await import('../lib/dashboard-periods.ts');
  const sites = (await prisma.site.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } })).map((s) => s.id);
  const NOW = new Date('2026-08-30T12:00:00Z');
  // A COST, SO THERE IS A COST BASE TO RECONCILE. Since costs became instance-backed, an empty
  // register WITHHOLDS the cost base — correctly, because a cost base with nothing in it is unknown
  // rather than low. Reconciliation is only a question when there is something to reconcile, so the
  // gate supplies one throwaway cost of its own and tears it down.
  const seed = await prisma.cost.create({
    data: { group_id: ZZ_GROUP, name: 'ZZANCHOR Rent', cadence: 'monthly', charge: 'spread',
      active_from: new Date('2025-01-01T00:00:00.000Z'),
      rates: { create: [{ effective_from: new Date('2025-01-01T00:00:00.000Z'), amount_pennies: 100_000 }] },
      allocations: { create: [{ group_id: ZZ_GROUP, site_id: sites[0], percent: 100 }] } },
    select: { id: true } });
  seededCostId = seed.id;
  const CG = await import('../lib/costs.ts');
  await CG.regenerate(seed.id, new Date('2025-01-01T00:00:00.000Z'), new Date('2027-01-01T00:00:00.000Z'));
  const sel = P.resolveMonthSpan({ mpreset: 'rolling_12' }, 4, NOW);
  for (const anchor of ['2025-09-01', '2026-04-01', '2026-06-01']) {
    if (typeof A.clipSpanToAnchor !== 'function') { check(`anchor ${anchor}: reconciles`, false, 'no clipSpanToAnchor'); continue; }
    const w = A.clipSpanToAnchor(sel.from, sel.to, new Date(`${anchor}T00:00:00.000Z`));
    const ctx = { groupId: ZZ_GROUP, siteIds: sites, from: w.from, to: w.to, months: w.months, now: NOW, dataStart: null };
    const [pnl, cb] = [await T.MONTH_TILE_COMPUTES.pnl(ctx), await T.MONTH_TILE_COMPUTES.costBase(ctx)];
    const fixedFromPnl = (pnl.wageBill ?? 0) + (pnl.operatingCosts ?? 0);
    check(`anchor ${anchor}: fixed costs reconcile to the penny`, fixedFromPnl === cb.costBasePennies,
      `pnl ${m(fixedFromPnl)} vs tile ${m(cb.costBasePennies)}`);
    check(`  …and both counted ${w.months} months`, pnl.months === w.months && cb.months === w.months,
      `pnl ${pnl.months} / costBase ${cb.months} / window ${w.months}`);
  }

  // ── 4. AND NO TILE CLIPS FOR ITSELF ───────────────────────────────────────────────────────────
  // The rule that keeps it fixed. Comment-stripped, and matched on the CALL shape — the file
  // necessarily discusses clipping in prose.
  console.log('\n— clipping is central, so a new tile cannot forget it —');
  const tilesSrc = prose('lib/dashboard-tiles.ts');
  const privateClips = [...tilesSrc.matchAll(/clipToData\s*\(/g)].length;
  check('no compute calls clipToData for itself', privateClips === 0,
    privateClips ? `${privateClips} private clip(s) remain — a tile that clips itself can disagree with one that does not` : 'the three private clips are gone');
  const apiSrc = prose('pages/api/dashboard-tiles.ts');
  check('the API clips before it computes',
    /clipSpanToAnchor\s*\(/.test(apiSrc) && apiSrc.indexOf('clipSpanToAnchor') < apiSrc.indexOf('computeTiles('),
    'one place, before any compute runs');

  // ── 5. THE SERVED PAGE ────────────────────────────────────────────────────────────────────────
  console.log('\n— what the garage sees —');
  check('the dev server serves pages before we drive it', await serverReady('/admin/login'));
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="breakeven-sub"]', { timeout: 60000 });
  const textOf = async (id) => (await page.$(`[data-testid="${id}"]`)) ? (await page.$eval(`[data-testid="${id}"]`, (el) => el.textContent.trim())) : null;

  // ZZ's records begin mid-2026, so the twelve-month default starts before the anchor.
  const note = await textOf('anchor-note');
  check('the disclosure names the SETTING, not an inference', note !== null && /reporting/i.test(note ?? ''),
    JSON.stringify(note));
  check('  …and points at the page that changes it',
    !!(await page.$('[data-testid="anchor-note"] a')), 'a disclosure the reader cannot act on is decoration');
  const href = await page.$eval('[data-testid="anchor-note"] a', (a) => a.getAttribute('href')).catch(() => null);
  check('  …which is Financial settings', href === '/admin/settings/financial', String(href));

  // ── 6. THE SETTING IS ON THE FINANCIAL PAGE, BESIDE THE FY START ──────────────────────────────
  await page.goto(`${BASE}/admin/settings/financial`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#fyStartMonth', { timeout: 40000 });
  check('the control sits on Financial settings', !!(await page.$('#reportingStart')),
    'beside "Financial year starts" — the other setting that frames every figure');
  // TWO SELECTS SINCE 2026-11-05. `#reportingStart` is the month half, so reading `.value` off it
  // alone now returns "11" and would have passed this clause against a control showing the wrong
  // YEAR entirely. readMonth composes both halves, which is the value the setting actually holds.
  const val = await readMonth(page, 'reportingStart').catch(() => null);
  check('  …showing the tenant’s current anchor', val === original.toISOString().slice(0, 7),
    `${JSON.stringify(val)} vs ${original.toISOString().slice(0, 10)}`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  // The anchor is a LIVE column on the gate tenant, not a throwaway row: whatever this run did, ZZ
  // leaves as it arrived, and the restore is asserted rather than assumed.
  if (prisma && seededCostId) {
    await prisma.costAllocation.deleteMany({ where: { cost_id: seededCostId } }).catch(() => {});
    await prisma.costInstance.deleteMany({ where: { cost_id: seededCostId } }).catch(() => {});
    await prisma.costRate.deleteMany({ where: { cost_id: seededCostId } }).catch(() => {});
    await prisma.cost.delete({ where: { id: seededCostId } }).catch(() => {});
    const leftCost = await prisma.cost.count({ where: { group_id: ZZ_GROUP, name: { startsWith: 'ZZANCHOR' } } }).catch(() => -1);
    check('teardown removed the seeded cost (ZZ only)', leftCost === 0, `${leftCost} left`);
  }
  if (prisma && original !== undefined) {
    await prisma.group.update({ where: { id: ZZ_GROUP }, data: { reporting_start_date: original } }).catch(() => {});
    const back = await prisma.group.findUnique({ where: { id: ZZ_GROUP }, select: { reporting_start_date: true } }).catch(() => null);
    check('the gate tenant’s anchor is exactly as it was',
      back?.reporting_start_date?.getTime() === original?.getTime(), String(back?.reporting_start_date));
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
