// @gate-timeout: 120
/**
 * File: scripts/costbase-clip-gate.mjs
 * TWO FIGURES ON THE SAME SCREEN, MEASURED OVER DIFFERENT MONTHS.
 *
 * utilisation and capacity both call clipToData — an unclipped window counts capacity for months
 * before the garage existed and reports the average as failure (38.17% where the traded months ran
 * 62.66%). costBase did not, and nothing said so.
 *
 * On TMBS, whose first record is 1 April 2026, a rolling-12 selection therefore put a TWELVE-month
 * cost base of £112,100.16 next to FIVE months of sellable capacity, and the break-even line read
 * "= 135% of sellable hours" — a garage told it cannot cover its costs by an arithmetic accident.
 * Both inputs were individually defensible. The ratio between them was fiction.
 *
 * ── THE MONTH COUNT MUST MOVE WITH THE WINDOW ───────────────────────────────────────────────────
 * costBase is monthly-cost × months. Clipping `from` without recomputing `months` bills twelve
 * months of payroll against a five-month window — the same error one layer down, and worse for
 * being invisible: the total would simply stay too big while the window looked right.
 *
 * NOT IN SCOPE, deliberately: the payroll model itself. A twelve-month cost base is everyone
 * employed at any point in the window, at END-OF-WINDOW pay, times twelve — £112,100.16 where the
 * sum of twelve individual months is £88,786.78. That is a real modelling choice and a separate
 * argument; this gate is only about the two figures sharing a window.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const T = await import('../lib/dashboard-tiles.ts');
const P = await import('../lib/dashboard-periods.ts');
const A = await import('../lib/reporting-anchor.ts');
const prisma = await gatePrisma();

const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const NOW = new Date('2026-08-29T12:00:00Z');
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

try {
  const sites = (await prisma.site.findMany({ where: { group_id: TMBS }, select: { id: true } })).map((s) => s.id);
  // A DATA START FIVE MONTHS AGO, stated rather than read: the gate is about the RULE, and pinning
  // the boundary keeps it true when the tenant's real first record moves.
  // AN ANCHOR FIVE MONTHS AGO, stated rather than read: the gate is about the RULE, and pinning the
  // boundary keeps it true when the tenant's own anchor moves.
  //
  // CLIPPED AT THE SEAM, NOT INSIDE THE TILE. costBase used to clip for itself; the clip now happens
  // once where the API builds the tile context, so this gate applies it the same way the API does.
  // The invariant is unchanged and is the reason the gate exists: the total must move with the
  // window, not just the window.
  const anchor = new Date('2026-04-01T00:00:00.000Z');
  const span = P.resolveMonthSpan({ mpreset: 'rolling_12' }, 4, NOW);
  const w = A.clipSpanToAnchor(span.from, span.to, anchor);
  const ctx = { groupId: TMBS, siteIds: sites, from: w.from, to: w.to, months: w.months, now: NOW, dataStart: null };

  const cb = await T.MONTH_TILE_COMPUTES.costBase(ctx);
  const ut = await T.MONTH_TILE_COMPUTES.utilisation(ctx);

  check('the selection really is twelve months', span.months === 12, `${span.from.toISOString().slice(0, 10)} → ${span.to.toISOString().slice(0, 10)}`);
  check('the window handed to the tiles is clipped to the anchor', w.months === 5 && w.clipped,
    `months=${w.months} — twelve months of payroll against five months of records is the defect`);
  check('  …and the cost base counted exactly those months', cb.months === 5, `months=${cb.months}`);

  // ── THE COST BASE IS NOW WITHHELD ON THIS TENANT ────────────────────────────────────────────
  // TMBS's Overhead rows were retired when costs moved to Cost/CostInstance, and an EMPTY register
  // withholds the cost base rather than reporting a smaller one — a cost base with nothing in it is
  // unknown, not low. So the figure this gate used to pin (£7,175.01 a month) no longer exists, and
  // asserting it would be asserting a number the product deliberately refuses to show.
  check('an empty cost register WITHHOLDS the cost base', cb.registerEmpty === true,
    'a smaller cost base and a lower break-even are exactly what a garage would act on');
  check('  …and does not smuggle a figure out anyway',
    cb.costBasePennies === undefined && cb.breakEvenCentihours === undefined, JSON.stringify(Object.keys(cb)));

  // THE DISCRIMINATING HALF, kept — on the wage bill, which is windowed and present. Clipping
  // `from` while leaving `months` at twelve produces a window that LOOKS right and a total 2.4×
  // too big, and that is the failure this gate exists to catch.
  const pnl = await T.MONTH_TILE_COMPUTES.pnl(ctx);
  const oneMonthWages = 717_501 - 223_501; // measured: the wage half of the old monthly cost base
  check('  …and the windowed total moved with it, not just the window',
    pnl.wageBill < oneMonthWages * 12 * 0.8,
    `£${(pnl.wageBill / 100).toFixed(2)} over ${cb.months} months — twelve would be far more`);

  // ── THE POINT OF ALL OF IT: ONE WINDOW, SO THE RATIO MEANS SOMETHING ────────────────────────
  const be = cb.breakEvenCentihours / 100;
  const sellable = ut.available ?? 0;
  const pct = sellable ? (be / sellable) * 100 : null;
  // BOTH DEFINED, not merely equal: undefined === undefined passed this vacuously before either
  // tile reported its window, which is the shape that makes a green check meaningless.
  // One window by CONSTRUCTION now — both tiles receive the same clipped context, so the check is
  // that they counted it the same, not that they each reported a window of their own.
  check('break-even and sellable cover the SAME window',
    cb.months === w.months && ut.available != null,
    `costBase months ${cb.months}, window ${w.months}, sellable ${ut.available}`);

  // A SINGLE MONTH INSIDE THE DATA MUST NOT MOVE. The clip only ever removes months before the
  // records begin, so a window entirely after the data start is untouched — and this is what stops
  // the fix quietly rewriting every figure the garage already knows.
  const one = P.resolveMonthSpan({ mpreset: 'this_month' }, 4, NOW);
  const pnl1 = await T.MONTH_TILE_COMPUTES.pnl({ ...ctx, from: one.from, to: one.to, months: 1 });
  check('a month inside the data is untouched', pnl1.months === 1 && pnl1.wageBill === 494_000,
    `months=${pnl1.months} £${(pnl1.wageBill / 100).toFixed(2)} — one month of payroll, unchanged by the clip`);

  // ── elapsedLabel REFUSES A SPAN IT CANNOT DESCRIBE ───────────────────────────────────────────
  // It names the month of `from` and pairs it with a day count over the WHOLE span, so a
  // September→August window renders "1–363 September": right shape, false claim. It was safe only
  // because one caller's guard happened to be undefined for multi-month — a different guard on the
  // same page (monthInProgress) is TRUE for that window, so the next person to reach for the
  // obvious one gets the wrong label immediately. It now refuses rather than trusting the caller.
  const dash = prose('pages/admin/dashboard.tsx');
  // SCOPED TO THE FUNCTION'S OWN BODY. A 600-character window after the name swept up a `return
  // null` belonging to a later function and passed before anything was written — an over-broad
  // scan reporting a fix that did not exist.
  const elapsedBody = (() => {
    const i = dash.indexOf('function elapsedLabel');
    return i < 0 ? '' : dash.slice(i, dash.indexOf('\n}', i) + 2);
  })();
  check('elapsedLabel refuses a span longer than a month', /return null/.test(elapsedBody),
    'a label that cannot describe the span must say nothing, not guess');
  check('  …and the caller handles the refusal', /elapsedLabel\([^)]*\)[\s\S]{0,120}?&&/.test(dash) || /const el = elapsedLabel/.test(dash),
    'rendering null is the point — the line disappears rather than lying');
} catch (e) {
  const kind = (e?.constructor?.name ?? typeof e) + (e?.code ? ` [${e.code}]` : '');
  console.log(`\n✗ THREW: ${kind}: ${describeError(e).slice(0, 300)}`);
  out.push('F');
} finally {
  await prisma.$disconnect();
}
const f = out.filter((x) => x === 'F').length;
console.log(`\n${f} failures of ${out.length}`);
process.exit(f ? 1 : 0);
