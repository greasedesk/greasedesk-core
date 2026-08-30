/**
 * File: scripts/tyres-gate.mjs
 * THREE READINGS PER CORNER — and the alignment job that only three can see.
 *
 * The assertion that carries this slice is that a measurement raises TWO different advisories, one
 * of which no single-depth model could produce. Everything else defends the thresholds and the
 * refusal to invent a wear rate.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const T = await import('../lib/tyres.ts');
const { printedDueItemsBlock } = await import('../lib/due-items.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const D = (o, c, i) => ({ outer: o, centre: c, inner: i });

// ── 1. THE TWO ADVISORIES ───────────────────────────────────────────────────────────────────────
console.log('\n— one measurement, two different jobs —');
const healthy = T.tyreAdvisories('front_left', D(60, 60, 60));
check('an even, healthy tyre advises nothing', healthy.length === 0);
const worn = T.tyreAdvisories('front_left', D(25, 25, 25));
check('an even, worn tyre advises DEPTH only', worn.length === 1 && worn[0].kind === 'depth', worn[0]?.description);
// THE CASE THE WHOLE TABLE EXISTS FOR.
const both = T.tyreAdvisories('front_left', D(60, 40, 20));
check('6.0/4.0/2.0 raises DEPTH **and** ALIGNMENT', both.length === 2
  && both.some((a) => a.kind === 'depth') && both.some((a) => a.kind === 'alignment'),
  both.map((a) => a.kind).join(' + '));
check('  …and the alignment one names the edge', /inside edge/.test(both.find((a) => a.kind === 'alignment').description));
// DISCRIMINATING: the same MINIMUM depth with even wear raises only one. The asymmetry is doing
// real work, not the depth.
const evenSameMin = T.tyreAdvisories('front_left', D(20, 20, 20));
check('  …the check is discriminating — 2.0/2.0/2.0 raises DEPTH ONLY', evenSameMin.length === 1,
  'same minimum depth, no asymmetry, no alignment job — a single-depth model cannot tell these apart');
// Caught EARLY, on a tyre with years left.
const earlyAlign = T.tyreAdvisories('rear_right', D(70, 50, 30));
check('alignment fires on a tyre with plenty of tread', earlyAlign.length === 1 && earlyAlign[0].kind === 'alignment',
  'catching the geometry before it destroys the tyre is the point');
check('over-inflation is NOT alignment — a low centre alone raises nothing',
  T.tyreAdvisories('front_left', D(60, 45, 60)).length === 0,
  'centre is excluded from the spread: that is a pressure fault');
check('below the legal limit says so', T.tyreAdvisories('front_left', D(14, 14, 14))[0].illegal === true);
check('  …and 1.6mm exactly is legal', T.tyreAdvisories('front_left', D(16, 16, 16))[0].illegal === false);

// ── 2. NO INVENTED WEAR RATE ────────────────────────────────────────────────────────────────────
console.log('\n— a first reading cannot say when —');
const at = (s) => new Date(`${s}T00:00:00Z`);
check('one reading → no rate', T.tyreWearRate([{ measuredAt: at('2026-01-01'), minTenths: 60, odometer: 10000 }]).reason === 'too_few');
check('two readings without odometers → no rate',
  T.tyreWearRate([{ measuredAt: at('2025-01-01'), minTenths: 70, odometer: null }, { measuredAt: at('2026-01-01'), minTenths: 50, odometer: null }]).reason === 'no_mileage');
const rate = T.tyreWearRate([{ measuredAt: at('2025-01-01'), minTenths: 70, odometer: 40000 }, { measuredAt: at('2026-01-01'), minTenths: 50, odometer: 50000 }]);
check('two readings WITH odometers → a real, measured rate', rate.ok && rate.tenthsPerThousandMiles === 2,
  rate.ok ? `${rate.tenthsPerThousandMiles} tenths per 1,000 miles over ${rate.milesCovered}` : rate.reason);
check('a tyre that GAINED tread was replaced, not slowed',
  T.tyreWearRate([{ measuredAt: at('2025-01-01'), minTenths: 30, odometer: 40000 }, { measuredAt: at('2026-01-01'), minTenths: 75, odometer: 50000 }]).reason === 'gained_tread');
check('miles-to-legal projects from the measured rate', T.milesToLegal(50, rate) === 17000, String(T.milesToLegal(50, rate)));
check('  …and NULL without one', T.milesToLegal(50, { ok: false, reason: 'too_few' }) === null,
  'a textbook "1mm per 10,000 miles" would be a fabricated constant');
const lib = readFileSync('lib/tyres.ts', 'utf8');
check('the refusal is explained where the next reader will be', /fabricated constant/.test(lib));

// ── 3. THE PRINTED LINE ─────────────────────────────────────────────────────────────────────────
console.log('\n— what prints on the invoice —');
const lines = T.printedTyreLines([
  { corner: 'rear_left', depths: D(70, 70, 70) },
  { corner: 'front_left', depths: D(60, 40, 20) },
]);
check('corners print in the car\'s order, fronts first', /^Front left/.test(lines[0]) && /^Rear left/.test(lines[1]));
check('the uneven one says so', lines[0] === 'Front left — 6.0 / 4.0 / 2.0mm (inside edge worn)', JSON.stringify(lines[0]));
check('an even one does not', lines[1] === 'Rear left — 7.0 / 7.0 / 7.0mm', JSON.stringify(lines[1]));
check('an illegal one is shouted', /BELOW LEGAL LIMIT/.test(T.printedTyreLines([{ corner: 'front_left', depths: D(14, 14, 14) }])[0]));
const block = printedDueItemsBlock({ motExpiry: null, items: [], tyreLines: lines });
check('tyres join the frozen block as TEXT lines', /\(1\) Front left — 6\.0/.test(block),
  'a structured table would print prettier and freeze worse');
const issue = readFileSync('lib/invoice-issue.ts', 'utf8');
check('the mint freezes the tyre lines with everything else', /tyreLines: printedTyreLines/.test(issue));

// ── 4. LIVE: THE WRITER, AND WHAT IT RAISES ─────────────────────────────────────────────────────
console.log('\n— on ZZ —');
let fix = null;
try {
  const site = await zzSite(prisma);
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ79 TYG', registration_normalized: 'ZZ79TYG' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft', odometer_in: 50000 }, select: { id: true } });
  fix = { veh: veh.id, card: card.id };
  await prisma.$transaction((tx) => T.recordTyreReadings(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, odometer: 50000,
    corners: [
      { corner: 'front_left', type: 'summer_standard', depths: D(60, 40, 20) },
      { corner: 'front_right', type: 'summer_standard', depths: D(60, 60, 60) },
    ],
  }));
  const items = await prisma.vehicleDueItem.findMany({ where: { vehicle_id: veh.id }, select: { description: true, due_basis: true } });
  check('two corners in, TWO advisories out — both from the worn one', items.length === 2,
    items.map((i) => i.description.slice(0, 34)).join(' | '));
  check('  …and both sit on next_service (no wear rate yet)', items.every((i) => i.due_basis === 'next_service'),
    'a first reading cannot say when');
  // RE-MEASURING corrects rather than stacks.
  await prisma.$transaction((tx) => T.recordTyreReadings(tx, {
    groupId: ZZ, vehicleId: veh.id, jobCardId: card.id, measuredBy: null, odometer: 50000,
    corners: [{ corner: 'front_left', type: 'summer_standard', depths: D(60, 40, 18) }],
  }));
  const after = await prisma.vehicleDueItem.count({ where: { vehicle_id: veh.id } });
  check('re-measuring the same corner CORRECTS, never stacks', after === 2, `${after} advisories`);
  const rd = await prisma.tyreReading.count({ where: { vehicle_id: veh.id } });
  check('  …and the reading is upserted, not duplicated', rd === 2, `${rd} readings for 2 corners`);
} catch (e) {
  check('fixture run completed', false, describeError(e).slice(0, 250));
} finally {
  if (fix) {
    await prisma.tyreReading.deleteMany({ where: { vehicle_id: fix.veh } });
    await prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.veh } });
    await prisma.jobCard.deleteMany({ where: { id: fix.card } });
    await prisma.vehicle.delete({ where: { id: fix.veh } }).catch(() => {});
    check('teardown removed every fixture row', (await prisma.vehicle.count({ where: { id: fix.veh } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
