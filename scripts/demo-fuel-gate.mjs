/**
 * File: scripts/demo-fuel-gate.mjs
 * Can the generator invent a car that never existed — and does constraining it quietly reshape the
 * fleet into something else?
 *
 * BOTH DIRECTIONS, because each earlier version of this rule passed a one-directional test and was
 * still wrong:
 *   • the first drew fuel independently of the model — a diesel Aygo, a 2015 electric 2008;
 *   • the second read "never a diesel" as "always petrol", silencing the Yaris and Jazz hybrids;
 *   • the third fell back to petrol on every rejection, turning an intended 58/30/8/4 book into
 *     73/24/2/0.5 with three electric cars in six hundred;
 *   • and none of them connected model year to nameplate launch, so 59 of 612 vehicles predated
 *     their own model.
 * A rule that only ever excludes will pass a test that only ever checks for exclusions.
 *
 * Exercises the pure functions directly — no database, no six-minute generation.
 */
import { pickVehicle, rng } from '../lib/demo/generate.ts';
import { VEHICLE_MIX, FUEL_MIX, DISTRIBUTIONS } from '../lib/demo/profile.ts';

const THIS_YEAR = 2026;
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const models = VEHICLE_MIX.flatMap((m) => m.models.map((x) => ({ ...x, make: m.make, share: m.share })));
const byName = new Map(models.map((m) => [m.name, m]));
const r = rng('fuel-gate');

// Draw ages the way the generator does, so the test sees the same fleet it will build.
const q = (u) => {
  const x = DISTRIBUTIONS.vehicleAgeYears;
  const seg = (a, b, lo, hi) => a + ((u - lo) / (hi - lo)) * (b - a);
  if (u < 0.10) return seg(x.p10 * 0.5, x.p10, 0, 0.10);
  if (u < 0.25) return seg(x.p10, x.p25, 0.10, 0.25);
  if (u < 0.50) return seg(x.p25, x.p50, 0.25, 0.50);
  if (u < 0.75) return seg(x.p50, x.p75, 0.50, 0.75);
  if (u < 0.90) return seg(x.p75, x.p90, 0.75, 0.90);
  return seg(x.p90, x.max, 0.90, 1);
};

// ── 1. NOTHING IMPOSSIBLE ────────────────────────────────────────────────────────────────────────
const bad = [];
const mix = {};
const ageByFuel = {};
const N = 60000;
for (let i = 0; i < N; i++) {
  const v = pickVehicle(r, THIS_YEAR, () => q(r()));
  const m = byName.get(v.model);
  mix[v.fuel] = (mix[v.fuel] ?? 0) + 1;
  (ageByFuel[v.fuel] ??= []).push(THIS_YEAR - v.year);
  if (v.year < m.from) bad.push(`${v.year} ${v.make} ${v.model} (from ${m.from})`);
  if (v.fuel === 'Diesel' && !m.diesel) bad.push(`diesel ${v.model}`);
  if (v.fuel === 'Electric' && (m.ev == null || v.year < m.ev)) bad.push(`${v.year} electric ${v.model}`);
  if (v.fuel === 'Hybrid' && (m.hyb == null || v.year < m.hyb)) bad.push(`${v.year} hybrid ${v.model}`);
}
const uniq = [...new Set(bad)];
console.log(`${N} draws across all ${models.length} models\n`);
check('no vehicle predates its own nameplate, no impossible fuel', uniq.length === 0,
  uniq.length ? `${uniq.length}: ${uniq.slice(0, 6).join(', ')}` : 'clean');

// ── 2. THE CARS THAT MUST STAY POSSIBLE ──────────────────────────────────────────────────────────
const find = (n) => models.find((m) => m.name === n);
// Drawn from the SAME 60,000 fleet rather than a synthetic probe, so these assert what the demo
// will actually contain, not what the function could theoretically return.
const fleet = [];
{ const r2 = rng('fleet-probe'); for (let i = 0; i < 60000; i++) fleet.push(pickVehicle(r2, THIS_YEAR, () => q(r2()))); }
const seen = (model, fuel) => fleet.some((v) => v.model === model && v.fuel === fuel);
for (const [label, model, fuel, must] of [
  ['a Yaris CAN appear as a hybrid', 'Yaris', 'Hybrid', true],
  ['a Jazz CAN appear as a hybrid', 'Jazz', 'Hybrid', true],
  ['a Corsa CAN appear as electric', 'Corsa', 'Electric', true],
  ['an Aygo NEVER appears as a diesel', 'Aygo', 'Diesel', false],
  ['an Insignia NEVER appears as a hybrid', 'Insignia', 'Hybrid', false],
  ['a Karoq NEVER appears as electric', 'Karoq', 'Electric', false],
]) {
  check(label, seen(model, fuel) === must);
}

// ── 3. THE MIX IS NOT RESHAPED BY REJECTIONS ─────────────────────────────────────────────────────
const pct = (f) => ((mix[f] ?? 0) / N) * 100;
const target = Object.fromEntries(FUEL_MIX.map((f) => [f.fuel, f.share]));
console.log('\n   fuel      target   realised');
for (const f of ['Petrol', 'Diesel', 'Hybrid', 'Electric']) {
  console.log(`   ${f.padEnd(9)} ${String(target[f]).padStart(5)}%   ${pct(f).toFixed(1).padStart(6)}%`);
}
// Petrol is the one that absorbed every rejection before, so it is the one to bound tightly.
check('petrol has not absorbed the rejections', Math.abs(pct('Petrol') - target.Petrol) <= 8,
  `${pct('Petrol').toFixed(1)}% vs ${target.Petrol}%`);
check('diesel is within 8 points', Math.abs(pct('Diesel') - target.Diesel) <= 8, `${pct('Diesel').toFixed(1)}%`);
// Electrified cannot reach its target on an eleven-year-old fleet — those cars did not exist. What
// matters is that the book is not empty of them, which 0.5% effectively was.
check('the book has a real hybrid presence', pct('Hybrid') >= 4, `${pct('Hybrid').toFixed(1)}%`);
check('the book has a real electric presence', pct('Electric') >= 1.5, `${pct('Electric').toFixed(1)}%`);

// The side effect of drawing fuel first, stated rather than hidden: electrified cars come out
// younger than the fleet average, because they could not have existed when the old ones were built.
const meanAge = (f) => (ageByFuel[f] ?? []).reduce((a, b) => a + b, 0) / ((ageByFuel[f] ?? []).length || 1);
console.log(`\n   mean age — petrol ${meanAge('Petrol').toFixed(1)}y  diesel ${meanAge('Diesel').toFixed(1)}y  hybrid ${meanAge('Hybrid').toFixed(1)}y  electric ${meanAge('Electric').toFixed(1)}y`);
check('electrified cars are younger than the fleet, as they must be',
  meanAge('Electric') < meanAge('Petrol') && meanAge('Hybrid') < meanAge('Petrol'));

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
