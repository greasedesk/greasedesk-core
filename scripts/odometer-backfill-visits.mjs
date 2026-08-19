/**
 * File: scripts/odometer-backfill-visits.mjs
 * OUR OWN ODOMETER READINGS, recovered from the job cards that already hold them.
 *
 *   node scripts/odometer-backfill-visits.mjs --group=GB-GD1967          > /tmp/b.log 2>&1
 *   node scripts/odometer-backfill-visits.mjs --group=GB-GD1967 --apply  > /tmp/b.log 2>&1
 *
 * DRY BY DEFAULT. --apply is the only thing that writes, and a tenant ref is always required:
 * there is no all-tenants mode.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────
 * NOT a DVSA sweep. It makes no external call and asks no permission question: every reading here
 * is one WE took, at the car, and already stored on the job card as `odometer_in`. It exists
 * because lib/odometer's rate needs two dated points and the readings were sitting un-dated in a
 * column nothing could span.
 *
 * ── THE DATE IS THE BOOKING SLOT ────────────────────────────────────────────────────────────────
 * `odometer_in` is read when the car ARRIVES, so `start_at` — the booked arrival — is the closest
 * honest stamp. It is present on all 208 TMBS cards, so the created_at fallback below never fires
 * on today's data; it exists only so a card without a booking cannot silently produce a reading
 * dated by when somebody happened to open the card.
 *
 * The invoice's `date_issued` was the alternative and is deliberately NOT used: it is when the work
 * was billed, which can be days after the odometer was read, and it is absent on 11 of the 208.
 *
 * ── SAFE TO RE-RUN ──────────────────────────────────────────────────────────────────────────────
 * recordOdometerReadings upserts on (vehicle, source, date), so a second run converges rather than
 * multiplying. Two cards for one car on one day collapse to a single reading — the later value
 * wins, which is the right answer for a car that came back the same day.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { recordOdometerReadings, readingsForVehicle, mileageRate } = await import('../lib/odometer.ts');

const ref = process.argv.find((a) => a.startsWith('--group='))?.split('=')[1];
const APPLY = process.argv.includes('--apply');
if (!ref) { console.log('Usage: --group=<ref> [--apply]'); process.exit(2); }

const g = await prisma.group.findFirst({ where: { ref }, select: { id: true, ref: true, group_name: true } });
if (!g) { console.log(`No tenant with ref ${ref}`); await prisma.$disconnect(); process.exit(2); }

const cards = await prisma.jobCard.findMany({
  where: { group_id: g.id, odometer_in: { not: null } },
  select: { id: true, vehicle_id: true, odometer_in: true, start_at: true, created_at: true },
  orderBy: { created_at: 'asc' },
});

// Collapse to (vehicle, date) BEFORE writing, so the reported figure is readings and not cards.
const byKey = new Map();
let noVehicle = 0, badReading = 0;
for (const c of cards) {
  if (!c.vehicle_id) { noVehicle += 1; continue; }
  const miles = c.odometer_in;
  if (!Number.isInteger(miles) || miles <= 0) { badReading += 1; continue; }
  const when = c.start_at ?? c.created_at;
  const date = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  byKey.set(`${c.vehicle_id}|${date.toISOString().slice(0, 10)}`, { vehicleId: c.vehicle_id, date, miles });
}

const before = await prisma.vehicleOdometerReading.count({ where: { group_id: g.id, source: 'visit' } });
console.log(`${g.ref} ${g.group_name} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  job cards with odometer_in : ${cards.length}`);
console.log(`  skipped, no vehicle        : ${noVehicle}`);
console.log(`  skipped, unusable reading  : ${badReading}`);
console.log(`  distinct (vehicle, date)   : ${byKey.size}   ← readings to write`);
console.log(`  visit readings already held: ${before}`);

const vehicles = new Set([...byKey.values()].map((v) => v.vehicleId));
console.log(`  vehicles covered           : ${vehicles.size}`);

if (!APPLY) {
  // What it would UNLOCK — the point of the exercise, stated before anything is written.
  const perVehicle = new Map();
  for (const v of byKey.values()) perVehicle.set(v.vehicleId, [...(perVehicle.get(v.vehicleId) ?? []), v]);
  let wouldRate = 0;
  for (const [, rs] of perVehicle) if (mileageRate(rs.map((r) => ({ date: r.date, miles: r.miles }))).ok) wouldRate += 1;
  console.log(`  vehicles that would gain a RATE from these alone: ${wouldRate}`);
  console.log('\nDry run — nothing written. Re-run with --apply.');
  await prisma.$disconnect();
  process.exit(0);
}

let written = 0;
for (const v of byKey.values()) {
  written += await recordOdometerReadings(prisma, {
    groupId: g.id, vehicleId: v.vehicleId, source: 'visit', readings: [{ date: v.date, miles: v.miles }],
  });
}
const after = await prisma.vehicleOdometerReading.count({ where: { group_id: g.id, source: 'visit' } });
console.log(`\n  upserts issued : ${written}`);
console.log(`  visit readings : ${before} → ${after}`);

let rated = 0;
for (const vid of vehicles) if ((mileageRate(await readingsForVehicle(prisma, g.id, vid))).ok) rated += 1;
console.log(`  vehicles with a computable rate: ${rated} of ${vehicles.size}`);
await prisma.$disconnect();
