/**
 * File: scripts/demo-fuel-gate.mjs
 * Can the generator invent a car that never existed?
 *
 * The first generated tenant contained a diesel Toyota Aygo and a 2015 electric Peugeot 2008 —
 * fuel was drawn independently of model and year. This demo is shown to people who would spot that
 * in a second, so it is worth its own gate. fuelFor is a pure function, so this exercises it
 * directly rather than spending six minutes generating a tenant to look at the result.
 */
import { fuelFor, rng } from '../lib/demo/generate.ts';
import { VEHICLE_MIX, PETROL_ONLY, EV_CAPABLE, EV_FROM, HYBRID_FROM } from '../lib/demo/profile.ts';

const r = rng('fuel-gate');
const bad = [];
let n = 0;
for (let i = 0; i < 40000; i++) {
  const mk = VEHICLE_MIX[i % VEHICLE_MIX.length];
  const model = mk.models[i % mk.models.length];
  const year = 1998 + (i % 30);
  const fuel = fuelFor(r, model, year);
  n += 1;
  if (fuel === 'Diesel' && PETROL_ONLY.includes(model)) bad.push(`diesel ${model}`);
  if (fuel === 'Electric' && year < EV_FROM) bad.push(`${year} electric ${model}`);
  if (fuel === 'Electric' && !EV_CAPABLE.includes(model)) bad.push(`electric ${model}`);
  if (fuel === 'Hybrid' && year < HYBRID_FROM) bad.push(`${year} hybrid ${model}`);
}
const uniq = [...new Set(bad)];
console.log(`${n} draws across every make/model/year in the mix`);
console.log(`${uniq.length === 0 ? '✓' : '✗'} no implausible combination` + (uniq.length ? `  — ${uniq.slice(0, 8).join(', ')}` : ''));

// And the two specific cars that were actually produced, named so a regression is unmistakable.
const aygo = Array.from({ length: 2000 }, () => fuelFor(r, 'Aygo', 2013));
const p2008 = Array.from({ length: 2000 }, () => fuelFor(r, '2008', 2015));
console.log(`${aygo.every((f) => f === 'Petrol') ? '✓' : '✗'} a 2013 Aygo is never a diesel  — ${[...new Set(aygo)].join('/')}`);
console.log(`${p2008.every((f) => f !== 'Electric') ? '✓' : '✗'} a 2015 Peugeot 2008 is never electric  — ${[...new Set(p2008)].join('/')}`);
process.exit(uniq.length ? 1 : 0);
