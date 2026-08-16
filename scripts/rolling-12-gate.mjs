/**
 * File: scripts/rolling-12-gate.mjs
 * The twelve-month comparison: right numbers, and four states that cannot be confused.
 */
import { prisma } from '../lib/db.ts';
import { withRetry } from './_gate-retry.mjs';
import { computeTiles } from '../lib/dashboard-tiles.ts';
import { presetRange, monthPresetSpan, isMonthlyComparison, rollingTwelveMonths, monthsOfRange, PERIOD_PRESETS, MONTH_PRESETS } from '../lib/dashboard-periods.ts';
import { getGroupUtilisation } from '../lib/capacity.ts';
import { getTenantDataStart } from '../lib/tenant-data-start.ts';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const NOW = new Date();

// ── PURE: the preset ────────────────────────────────────────────────────────────────────────────
check('rolling_12 is a first-class preset, not a custom range', PERIOD_PRESETS.includes('rolling_12'));
check('the P&L strip follows it (whole months, no degradation)', MONTH_PRESETS.includes('rolling_12'));
const r = presetRange('rolling_12', 4, NOW);
const span = monthPresetSpan('rolling_12', 4, NOW);
check('it is exactly twelve whole months', span.months === 12, `${r.from.toISOString().slice(0,10)} → ${r.to.toISOString().slice(0,10)}`);
check('both ends are month boundaries', r.from.getUTCDate() === 1 && r.to.getUTCDate() === 1);
check('it ENDS with the current month, so the last bar is live',
  r.to.getUTCMonth() === (NOW.getUTCMonth() + 1) % 12);
check('only rolling_12 asks for the comparison chart',
  isMonthlyComparison('rolling_12') && !isMonthlyComparison('this_fy') && !isMonthlyComparison('this_month'));
check('rollingTwelveMonths yields twelve keyed months, oldest first', (() => {
  const ms = rollingTwelveMonths(NOW);
  return ms.length === 12 && ms[0].from < ms[11].from && ms[11].to.getTime() === r.to.getTime();
})());

// ── RETRIED AS A WHOLE, BECAUSE THIS GATE IS READ-ONLY ──────────────────────────────────────────
// Neon drops connections and an abort mid-run reports a red that means nothing. The database half
// of this gate WRITES NOTHING — it computes tiles against the frozen reference demo tenant — so
// re-running it from the top is safe, and a whole-body retry covers the ~40 queries inside
// computeTiles that import prisma themselves and cannot be reached by wrapping a local binding.
//
// Gates that DO write their own fixtures must not use this: they refuse to start on leftovers, so
// a second attempt after a half-completed first one aborts on its own litter. Those use
// retryingPrisma from the same file, which retries the single query that died.
//
// RECOVERY IS REPORTED. `dbAttempts` is printed in the summary, so a run that limped to green says
// so — a gate that recovers every time is a flaky gate hiding behind eventual green.
let dbAttempts = 1;
const beforeDb = out.length;
try {
  const { attempts } = await withRetry(async () => {
    out.length = beforeDb;   // a repeat must not double the checks it already recorded
    return runDbChecks();
  }, { attempts: 4, onRetry: (a, e) => console.log(`\n… transient database fault on attempt ${a} (${e?.code ?? '—'}) — retrying`) });
  dbAttempts = attempts;
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 240));
}

async function runDbChecks() {
  const u = await prisma.user.findUnique({ where: { email: 'demo.owner.reference15@example.com' }, select: { group_id: true } });
  const g = u.group_id;
  const site = await prisma.site.findFirst({ where: { group_id: g }, select: { id: true } });
  const dataStart = await getTenantDataStart(g);
  const base = { groupId: g, siteIds: [site.id], now: NOW, dataStart };

  const t0 = Date.now();
  const tiles = await computeTiles({ ...base, from: r.from, to: r.to }, { ...base, from: span.from, to: span.to, months: span.months });
  const ms = Date.now() - t0;
  const cap = tiles.capacity;
  console.log(`\n   computeTiles(rolling_12): ${ms}ms\n`);

  check('the monthly split is produced', Array.isArray(cap.monthly), `${cap.monthly?.length ?? 0} months`);
  // Clipping is correct ONLY when the tenant's records begin inside the window. This tenant is
  // older than twelve months, so the honest expectation is NO clip.
  const startsInside = dataStart > r.from;
  check(`the clip flag matches reality (records ${startsInside ? 'begin inside' : 'predate'} the window)`,
    cap.clippedToDataStart === startsInside, `clipped=${cap.clippedToDataStart}, dataStart ${dataStart.toISOString().slice(0, 10)}, window opens ${r.from.toISOString().slice(0, 10)}`);

  // ── THE NUMBERS. Each bucket must equal an independent per-month read. ────────────────────────
  let allAgree = true;
  for (const m of cap.monthly) {
    const from = new Date(`${m.key}-01T00:00:00.000Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const indep = await getGroupUtilisation(g, [site.id], { from: from < new Date(cap.measuredFromISO) ? new Date(cap.measuredFromISO) : from, to });
    const ok = Math.abs(indep.available - m.sellableHours) < 0.05;
    if (!ok) { allAgree = false; console.log(`    ✗ ${m.key}: bucketed ${m.sellableHours}h vs ${indep.available}h`); }
  }
  check('EVERY bucketed month equals an independent getGroupUtilisation read', allAgree,
    `${cap.monthly.length} months cross-checked`);

  // ── THE FOUR STATES ───────────────────────────────────────────────────────────────────────────
  const keys = rollingTwelveMonths(NOW).map((m) => m.key);
  const present = new Set(cap.monthly.map((m) => m.key));
  const absent = keys.filter((k) => !present.has(k));
  const nowKey = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`;
  console.log(`   absent (no bar): ${absent.join(', ') || 'none'}`);
  console.log(`   months: ${cap.monthly.map((m) => `${m.key} ${m.ratio === null ? '—' : (m.ratio * 100).toFixed(0) + '%'}${m.live ? '*' : ''}`).join('  ')}\n`);

  check('STATE absent: pre-existence months are MISSING, not zero rows',
    absent.every((k) => k < (cap.measuredFromISO ?? '').slice(0, 7)) && !cap.monthly.some((m) => m.key < cap.measuredFromISO.slice(0, 7)),
    absent.length ? `${absent.length} absent` : 'tenant older than 12 months');
  check('STATE ratio-null is used for no-capacity, never for zero sales',
    cap.monthly.every((m) => (m.ratio === null) === !(m.sellableHours > 0)));
  check('STATE zero: a month that sold nothing still reports a ratio of 0, not null',
    cap.monthly.every((m) => !(m.sellableHours > 0 && m.soldPennies === 0) || m.ratio === 0));
  check('STATE live: exactly one month is flagged live, and it is this one',
    cap.monthly.filter((m) => m.live).length === 1 && cap.monthly.find((m) => m.live).key === nowKey, nowKey);

  // ── SOLD IS REVENUE, NOT HOURS × RATE ─────────────────────────────────────────────────────────
  const live = cap.monthly.find((m) => m.live);
  check('sold value is present for the live month', live.soldPennies > 0, `£${(live.soldPennies / 100).toFixed(2)}`);
  check('the monthly sold total reconciles with the period total',
    Math.abs(cap.monthly.reduce((a, m) => a + m.soldPennies, 0) - (cap.actualPennies ?? 0)) <= cap.monthly.length,
    `Σ£${(cap.monthly.reduce((a, m) => a + m.soldPennies, 0) / 100).toFixed(2)} vs £${((cap.actualPennies ?? 0) / 100).toFixed(2)}`);
  check('and the monthly sellable total reconciles too',
    Math.abs(cap.monthly.reduce((a, m) => a + m.sellableHours, 0) - cap.sellableHours) < 0.05,
    `${cap.monthly.reduce((a, m) => a + m.sellableHours, 0).toFixed(2)}h vs ${cap.sellableHours}h`);

  // ── THE ABSENT STATE, EXERCISED RATHER THAN ASSUMED ───────────────────────────────────────────
  // The reference tenant is older than twelve months, so the assertion above passed VACUOUSLY —
  // there were no absent months to get wrong. dataStart is an INPUT to the tile, so a young tenant
  // can be simulated exactly: same data, first record five months ago.
  {
    const young = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 4, 1));
    const t = await computeTiles({ ...base, dataStart: young, from: r.from, to: r.to },
      { ...base, dataStart: young, from: span.from, to: span.to, months: span.months });
    const c = t.capacity;
    const shown = new Set(c.monthly.map((m) => m.key));
    const missing = keys.filter((k) => !shown.has(k));
    console.log(`\n   simulated first record ${young.toISOString().slice(0, 10)} → ${c.monthly.length} bars, ${missing.length} absent\n`);
    check('ABSENT (exercised): a younger tenant gets FEWER bars, not zero-height ones',
      c.monthly.length === 5 && missing.length === 7, `${c.monthly.length} bars, absent ${missing.join(',')}`);
    check('… every absent month is genuinely before the first record',
      missing.every((k) => k < young.toISOString().slice(0, 7)));
    check('… every shown month is on or after it', c.monthly.every((m) => m.key >= young.toISOString().slice(0, 7)));
    check('… and NONE of them is a zero row masquerading as a month', c.monthly.every((m) => m.sellableHours > 0));
    check('… the clip is flagged so the surface can say the period was shortened', c.clippedToDataStart === true);
    check('… and a real month\'s figures are IDENTICAL to the unclipped run — the clip removes months, it does not alter them',
      (() => { const a = c.monthly.find((m) => m.key === nowKey), b2 = cap.monthly.find((m) => m.key === nowKey);
        return a && b2 && a.sellableHours === b2.sellableHours && a.soldPennies === b2.soldPennies; })());
  }

  // ── THE TWO CLOSED FISCAL COMPARISONS ─────────────────────────────────────────────────────────
  // Same chart, a different window, and NO live month in either — so no light, by construction
  // rather than by a rule that remembers to switch it off.
  for (const [preset, offset] of [['fy_last_by_month', -1], ['fy_prior_by_month', -2]]) {
    const fr = presetRange(preset, 4, NOW), fs = monthPresetSpan(preset, 4, NOW);
    const plain = presetRange(offset === -1 ? 'last_fy' : 'this_fy', 4, NOW);
    check(`${preset}: twelve whole months`, fs.months === 12, `${fr.from.toISOString().slice(0,10)} → ${fr.to.toISOString().slice(0,10)}`);
    check(`${preset}: renders the comparison chart`, isMonthlyComparison(preset));
    if (offset === -1) {
      check(`${preset}: the SAME window last_fy already reports — one definition of a fiscal year`,
        fr.from.getTime() === plain.from.getTime() && fr.to.getTime() === plain.to.getTime());
    }
    check(`${preset}: starts on the tenant's fiscal month, not January`,
      fr.from.getUTCMonth() === 3, `month ${fr.from.getUTCMonth() + 1} for fyStartMonth=4`);
    // A non-April tenant must get its own year — the gap this would hide if fy were hardcoded.
    const july = presetRange(preset, 7, NOW);
    check(`${preset}: a July fiscal year starts in July`, july.from.getUTCMonth() === 6,
      `${july.from.toISOString().slice(0,10)} → ${july.to.toISOString().slice(0,10)}`);
    check(`${preset}: and monthsOfRange follows it — Jul…Jun, not Jan…Dec`,
      (() => { const ms = monthsOfRange(july.from, july.to); return ms.length === 12 && ms[0].from.getUTCMonth() === 6 && ms[11].from.getUTCMonth() === 5; })());

    const ft = await computeTiles({ ...base, from: fr.from, to: fr.to }, { ...base, from: fs.from, to: fs.to, months: fs.months });
    const fc = ft.capacity;
    // A fiscal year entirely before the tenant existed is SUPPOSED to produce nothing. Asserting a
    // split here would demand the very fabrication clipToData exists to prevent.
    const entirelyBefore = fr.to <= dataStart;
    if (entirelyBefore) {
      check(`${preset}: entirely before the tenant → NOTHING, not twelve empty bars`,
        fc.beforeData === true && fc.monthly === undefined, JSON.stringify(fc));
      check(`${preset}: … and the card renders no chart at all for it`,
        fc.beforeData === true || !Array.isArray(fc.series),
        'the client guard tests beforeData AND a missing series, not just cap == null');
      continue;
    }
    check(`${preset}: the monthly split is produced`, Array.isArray(fc.monthly), `${fc.monthly?.length ?? 0} months`);
    check(`${preset}: NO month is live — so the chart cannot draw a light`,
      fc.monthly.every((m) => !m.live), fc.monthly.filter((m) => m.live).map((m) => m.key).join(',') || 'none live');
    check(`${preset}: it reads clipToData like the rolling view`,
      fc.clippedToDataStart === (dataStart > fr.from), `clipped=${fc.clippedToDataStart}`);
  }

  // ── AND THE SINGLE-MONTH VIEW IS UNTOUCHED ────────────────────────────────────────────────────
  const mr = presetRange('this_month', 4, NOW), msp = monthPresetSpan('this_month', 4, NOW);
  const single = await computeTiles({ ...base, from: mr.from, to: mr.to }, { ...base, from: msp.from, to: msp.to, months: msp.months });
  check('a single month still gets the burn-up, with NO monthly split',
    single.capacity.monthly === null && Array.isArray(single.capacity.series),
    `${single.capacity.series.length} daily points`);
}

if (dbAttempts > 1) {
  console.log(`\n⚠ RECOVERED after ${dbAttempts} attempts — green, but the run was NOT clean.`);
  console.log('  Recovering every time means the gate is flaky, not that the code is fine.');
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}${dbAttempts > 1 ? `  (db attempts: ${dbAttempts})` : ''}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
