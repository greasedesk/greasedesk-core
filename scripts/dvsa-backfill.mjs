/**
 * File: scripts/dvsa-backfill.mjs
 * THE ONE-TIME CATCH-UP — MOT dates and odometer history for cars that predate the leak being fixed.
 *
 * ── WHY THIS IS WORTH RUNNING AND WAS NOT BEFORE ────────────────────────────────────────────────
 * Two write-path defects, both now closed, left every existing car short:
 *
 *   1. The diary quick-book never captured motExpiry / lastMotMileage / lastMotDate. A deliberate
 *      scope decision ("a booking stays off the MOT hot path"), whose measured price was 96 of 221
 *      TMBS cars with no MOT date and coverage falling 83% → 60% → 47% by creation month.
 *
 *   2. NO creating surface ever backfilled the DVSA odometer history. /api/dvsa-lookup keeps it only
 *      when told which vehicle it belongs to, and at first lookup the vehicle does not exist yet;
 *      it deferred to "the next lookup", which only the job card's manual button performs. Result:
 *      ZERO MOT-sourced readings for any car, ever, and only 30 of 221 with the two readings a
 *      mileage rate needs.
 *
 * A sweep run BEFORE those fixes would have been a treadmill — the numbers would decay again within
 * a quarter and the backfill would hide the trend. Run after, it is a genuine catch-up.
 *
 * ── WHAT IT IS WORTH ────────────────────────────────────────────────────────────────────────────
 * The odometer history is the point, not the MOT dates. A rate needs two readings 90 days apart
 * (lib/odometer::MIN_SPAN_DAYS), and DVSA carries one per test — a nine-year-old car brings nine
 * readings spanning nine years. That rate is what the servicing list's dated band, the tyre wear
 * rate and the battery decline projection all run on, and today they run on 14% of the fleet.
 *
 * ── HOW IT BEHAVES ──────────────────────────────────────────────────────────────────────────────
 * DRY RUN BY DEFAULT. Pass --write to store. One tenant at a time (--group=<id>), because a sweep
 * across every tenant at once is a quota question nobody has answered — see the Engine Room quota
 * view, still unbuilt.
 *
 * Best-effort per car, exactly like the live lookup: a miss, a 404 or a network error stores
 * nothing and never stops the run. Paced, because this is somebody else's API.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { dvsaLookup, dvsaConfigured } = await import('../lib/dvsa.ts');
const { recordOdometerReadings } = await import('../lib/odometer.ts');
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const GROUP = (args.find((a) => a.startsWith('--group=')) ?? '').split('=')[1] || null;
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) ?? '').split('=')[1] || 0) || null;
/** One request every 250ms. DVSA is somebody else's service and a sweep is not urgent. */
const PACE_MS = Number((args.find((a) => a.startsWith('--pace=')) ?? '').split('=')[1] || 250);

if (!GROUP) {
  console.error('\n  --group=<id> is required.\n\n  ONE TENANT AT A TIME, deliberately: a sweep across every tenant is a quota\n  question nobody has answered, and this script must not be the place it gets\n  answered by accident.\n');
  process.exit(2);
}
if (!dvsaConfigured()) {
  console.error('\n  DVSA is not configured in this environment — nothing to sweep with.\n');
  process.exit(2);
}

const group = await prisma.group.findUnique({ where: { id: GROUP }, select: { group_name: true } });
if (!group) { console.error(`\n  No group ${GROUP}.\n`); process.exit(2); }

const vehicles = await prisma.vehicle.findMany({
  where: { group_id: GROUP },
  select: { id: true, registration: true, mot_expiry: true, last_mot_mileage: true },
  orderBy: { created_at: 'asc' },
  ...(LIMIT ? { take: LIMIT } : {}),
});

console.log(`\n  ${WRITE ? 'WRITING' : 'DRY RUN'} — ${group.group_name}, ${vehicles.length} vehicles, ${PACE_MS}ms apart\n`);

let looked = 0, missed = 0, gotExpiry = 0, gotReadings = 0, readingRows = 0, errors = 0;
const before = await prisma.vehicleOdometerReading.count({ where: { group_id: GROUP, source: 'mot' } });

for (const v of vehicles) {
  await new Promise((r) => setTimeout(r, PACE_MS));
  let data = null;
  try { data = await dvsaLookup(v.registration); } catch { errors += 1; continue; }
  looked += 1;
  if (!data) { missed += 1; continue; }

  if (data.motExpiry && !v.mot_expiry) {
    gotExpiry += 1;
    if (WRITE) {
      await prisma.vehicle.update({
        where: { id: v.id },
        data: {
          mot_expiry: new Date(`${data.motExpiry}T00:00:00.000Z`),
          ...(data.lastMotMileage != null ? { last_mot_mileage: data.lastMotMileage } : {}),
          ...(data.lastMotDate ? { last_mot_date: new Date(`${data.lastMotDate}T00:00:00.000Z`) } : {}),
        },
      });
    }
  }
  if (data.odometerHistory?.length) {
    gotReadings += 1;
    readingRows += data.odometerHistory.length;
    // UPSERT ON (vehicle, source, date) — running this twice converges rather than accumulating,
    // which is what makes a sweep safe to re-run after a partial failure.
    if (WRITE) await recordOdometerReadings(prisma, { groupId: GROUP, vehicleId: v.id, source: 'mot', readings: data.odometerHistory });
  }
}

const after = WRITE ? await prisma.vehicleOdometerReading.count({ where: { group_id: GROUP, source: 'mot' } }) : before;
const rateCapable = async () => {
  const g = await prisma.vehicleOdometerReading.groupBy({
    by: ['vehicle_id'], where: { group_id: GROUP }, _count: { _all: true },
    having: { vehicle_id: { _count: { gte: 2 } } },
  });
  return g.length;
};

console.log(`\n  looked up          ${looked}`);
console.log(`  no DVSA record     ${missed}`);
console.log(`  errors             ${errors}`);
console.log(`  MOT dates to gain  ${gotExpiry}`);
console.log(`  cars with history  ${gotReadings}`);
console.log(`  readings to store  ${readingRows}  (${gotReadings ? (readingRows / gotReadings).toFixed(1) : 0} per car)`);
console.log(`  mot readings       ${before} → ${after}`);
console.log(`  rate-capable cars  ${await rateCapable()} of ${vehicles.length}`);
if (!WRITE) console.log('\n  DRY RUN — nothing was written. Re-run with --write.\n');

await prisma.$disconnect();
