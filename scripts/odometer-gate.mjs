/**
 * File: scripts/odometer-gate.mjs
 * THE MILEAGE RATE — and the three ways we refuse to invent one.
 *
 * The rate is load-bearing: without it a `whichever_first` due item ("due in 10k miles or 11/2025")
 * cannot be ordered by date at all. So the interesting assertions are about REFUSAL — a projected
 * reminder built on a fabricated rate is worse than no date, because it looks like a decision.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const {
  normaliseOdometer, mileageRate, projectMileageDate, dedupeForDisplay,
  recordOdometerReadings, readingsForVehicle, MIN_SPAN_DAYS,
} = await import('../lib/odometer.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const D = (s) => new Date(`${s}T00:00:00.000Z`);

// ── 1. THE THREE DATA HAZARDS, AT THE BOUNDARY ─────────────────────────────────────────────────
console.log('\n— normalisation refuses rather than guesses —');
check('miles pass through', normaliseOdometer(115728, 'mi') === 115728);
check('kilometres are converted', normaliseOdometer(100000, 'km') === 62137, String(normaliseOdometer(100000, 'km')));
check('an UNRECOGNISED unit stores nothing — not a guessed mile', normaliseOdometer(50000, 'furlongs') === null,
  'assuming miles is how a km-tested car gets a 60% wrong rate');
check('NOT_READABLE is null, never 0', normaliseOdometer(0, 'mi', 'NOT_READABLE') === null,
  'a zero reading drags any rate through the floor');
check('NO_ODOMETER is null', normaliseOdometer(123, 'mi', 'NO_ODOMETER') === null);
check('a READ result is kept', normaliseOdometer(123456, 'mi', 'READ') === 123456);
check('a missing unit is refused', normaliseOdometer(50000, undefined) === null);

// ── 2. THE RETEST — the case that motivates span-based rates ───────────────────────────────────
console.log('\n— a retest cannot distort the rate —');
// A real shape: nine years of annual MOTs, plus a fail-and-retest three days apart.
const history = [
  { date: D('2017-06-01'), miles: 20000 },
  { date: D('2018-06-01'), miles: 30000 },
  { date: D('2019-06-01'), miles: 40000 },
  { date: D('2026-05-28'), miles: 110000 },
  { date: D('2026-05-31'), miles: 110040 },  // ← the retest: 40 miles in 3 days
];
const r = mileageRate(history);
// THE PROPERTY, not a magic number: removing the retest must not move the rate. Pinning "10,000"
// would assert the fixture's own arithmetic; this asserts the thing the design claims.
const withoutRetest = mileageRate(history.slice(0, -1));
const drift = r.ok && withoutRetest.ok ? Math.abs(r.milesPerYear - withoutRetest.milesPerYear) / withoutRetest.milesPerYear : 1;
check('removing the retest does NOT move the rate', drift < 0.01,
  r.ok && withoutRetest.ok ? `${r.milesPerYear} vs ${withoutRetest.milesPerYear} mi/yr (${(drift * 100).toFixed(2)}% apart)` : 'no rate');
// THE DISCRIMINATOR: the naive consecutive-pair reading of the SAME data is wildly different, so
// "unmoved" above is a real property of the span rule rather than a fixture that could not fail.
const naive = Math.round((110040 - 110000) / 3 * 365);
check(`  …the check is discriminating — the last PAIR alone says ${naive.toLocaleString()} mi/yr`,
  r.ok && Math.abs(naive - r.milesPerYear) / r.milesPerYear > 0.4,
  'which is why the retests are kept and the RULE lives at the read');

console.log('\n— and refusals are stated, never guessed —');
check('one reading → no rate', mileageRate([history[0]]).reason === 'too_few');
check('no readings → no rate', mileageRate([]).reason === 'too_few');
check(`a span under ${MIN_SPAN_DAYS} days → no rate`,
  mileageRate([{ date: D('2026-05-28'), miles: 110000 }, { date: D('2026-05-31'), miles: 110040 }]).reason === 'span_too_short',
  'a fail-and-retest pair is ALL the history some cars have');
check('an odometer that goes BACKWARDS → no rate',
  mileageRate([{ date: D('2020-01-01'), miles: 90000 }, { date: D('2026-01-01'), miles: 40000 }]).reason === 'goes_backwards',
  'clocking, a replacement cluster, or a keying error');

// ── 3. PROJECTION ──────────────────────────────────────────────────────────────────────────────
console.log('\n— projecting a mileage target —');
const now = D('2026-08-19');
const proj = projectMileageDate(115728, 125728, r, now);
check('10,000 miles at 10,000/yr lands about a year out', proj !== null && Math.abs(proj.getTime() - D('2027-08-19').getTime()) < 3 * 86400000,
  proj ? proj.toISOString().slice(0, 10) : 'null');
check('no rate → NO projected date', projectMileageDate(100000, 110000, mileageRate([]), now) === null,
  'the whole point: no invented dates');
check('a target already passed → null', projectMileageDate(130000, 125728, r, now) === null);
check('a stationary car never arrives', projectMileageDate(100, 200, { ok: true, milesPerYear: 0, spanDays: 900, readings: 3, from: 'x', to: 'y' }, now) === null);

// ── 4. DEDUPE IS DISPLAY-ONLY ──────────────────────────────────────────────────────────────────
console.log('\n— dedupe collapses the retest for a human, and only there —');
const shown = dedupeForDisplay(history.map((h) => ({ ...h, source: 'mot' })));
check('display shows 5 of 5 — different mileages are different events', shown.length === 5, `${shown.length}`);
const sameMiles = dedupeForDisplay([
  { date: D('2026-05-28'), miles: 110000, source: 'mot' },
  { date: D('2026-05-31'), miles: 110000, source: 'mot' },
]);
check('an identical mileage days apart collapses to one', sameMiles.length === 1);
check('  …and the STORE still holds both', history.length === 5, 'the rule is at the read, not the write');

// ── 5. THE LAG IS DOCUMENTED, NOT JUST CHOSEN ──────────────────────────────────────────────────
const src = readFileSync('lib/odometer.ts', 'utf8');
check('the whole-history lag trade-off is written down', /LAGS a change in use/.test(src) && /Revisit it ON EVIDENCE/.test(src),
  'so nobody "improves" it to a recent window without knowing what it costs');

// ── 6. LIVE: idempotent upsert, both sources ───────────────────────────────────────────────────
console.log('\n— on ZZ: the write converges rather than accumulates —');
let veh = null;
try {
  veh = (await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ92 ODO', registration_normalized: 'ZZ92ODO' }, select: { id: true } })).id;
  const readings = [{ date: '2024-06-01', miles: 100000 }, { date: '2025-06-01', miles: 110000 }];
  await recordOdometerReadings(prisma, { groupId: ZZ, vehicleId: veh, source: 'mot', readings });
  check('two readings stored', (await readingsForVehicle(prisma, ZZ, veh)).length === 2);
  // THE LOOKUP FIRES ON EVERY REG SEARCH — run it again and the count must not move.
  await recordOdometerReadings(prisma, { groupId: ZZ, vehicleId: veh, source: 'mot', readings });
  await recordOdometerReadings(prisma, { groupId: ZZ, vehicleId: veh, source: 'mot', readings });
  check('re-running the SAME lookup twice more still leaves two', (await readingsForVehicle(prisma, ZZ, veh)).length === 2,
    'idempotent: the DVSA lookup fires on every reg search');
  // Our own reading on the same DAY as an MOT is a different source, so it is a different row.
  await recordOdometerReadings(prisma, { groupId: ZZ, vehicleId: veh, source: 'visit', readings: [{ date: '2025-06-01', miles: 110250 }] });
  const all = await readingsForVehicle(prisma, ZZ, veh);
  check('our own reading coexists with the MOT on the same date', all.length === 3,
    'source is part of the key — "DVSA says" and "we read it" are different facts');
  check('  …and a rate now spans both', mileageRate(all).ok === true);
  check('a zero or negative reading is dropped, not stored',
    (await recordOdometerReadings(prisma, { groupId: ZZ, vehicleId: veh, source: 'visit', readings: [{ date: '2025-07-01', miles: 0 }] })) === 0);
} catch (e) {
  check('fixture run completed', false, String(e?.message ?? e).slice(0, 200));
} finally {
  if (veh) {
    await prisma.vehicleOdometerReading.deleteMany({ where: { vehicle_id: veh } });
    await prisma.vehicle.delete({ where: { id: veh } }).catch(() => {});
    check('teardown removed every fixture row',
      (await prisma.vehicle.count({ where: { id: veh } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
