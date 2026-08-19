/**
 * File: scripts/dvsa-backfill.mjs
 * THE ONE-TIME CATCH-UP — MOT dates and odometer history for cars that predate the leak being fixed.
 *
 * ── WHY THIS IS WORTH RUNNING AND WAS NOT BEFORE ────────────────────────────────────────────────
 * Two write-path defects, both now closed, left every existing car short:
 *
 *   1. The diary quick-book never captured motExpiry / lastMotMileage / lastMotDate. A deliberate
 *      scope decision ("a booking stays off the MOT hot path"), whose price was 96 of 221 TMBS cars
 *      with no MOT date and coverage falling 83% → 60% → 47% by creation month — measured
 *      19 Aug 2026, before this sweep ran.
 *
 *   2. NO creating surface ever backfilled the DVSA odometer history. /api/dvsa-lookup keeps it only
 *      when told which vehicle it belongs to, and at first lookup the vehicle does not exist yet;
 *      it deferred to "the next lookup", which only the job card's manual button performs. Result:
 *      ZERO MOT-sourced readings for any car, ever (19 Aug 2026), and only 30 of 221 with the two readings a
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
// ── LOAD .env EXPLICITLY ────────────────────────────────────────────────────────────────────────
// prisma.config.ts exists, which stops Prisma auto-loading .env, and it imports dotenv only for
// itself — so a plain script gets its DATABASE_URL through Prisma's own config and `process.env`
// is never populated with anything else. Without this, correct DVSA credentials sitting in .env
// still read as absent, and the refusal below would look like the secrets being wrong.
import 'dotenv/config';
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const { dvsaLookup, dvsaConfigured } = await import('../lib/dvsa.ts');
const { recordOdometerReadings, mileageRate } = await import('../lib/odometer.ts');
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
const perCar = [];
let rateAfter = 0;
const rateRefused = {};
const anomalies = [];
// What each car ALREADY has, so the projection is "after the sweep", not "from DVSA alone".
const existingReadings = new Map();
for (const v of vehicles) {
  const rows = await prisma.vehicleOdometerReading.findMany({
    where: { group_id: GROUP, vehicle_id: v.id }, select: { reading_date: true, miles: true },
  });
  existingReadings.set(v.id, rows.map((r) => ({ date: r.reading_date, miles: r.miles })));
}
const before = await prisma.vehicleOdometerReading.count({ where: { group_id: GROUP, source: 'mot' } });

for (const v of vehicles) {
  await new Promise((r) => setTimeout(r, PACE_MS));
  let data = null;
  try { data = await dvsaLookup(v.registration); } catch { errors += 1; continue; }
  looked += 1;
  if (!data) {
    missed += 1;
    // A MISS IS NOT AN ERROR AND NOT AN EMPTY HISTORY. dvsaLookup returns null for an unknown reg
    // (404) and for a transport failure alike — the two are indistinguishable to a caller, which is
    // worth saying rather than reporting them together as "no history".
    perCar.push({ reg: v.registration, readings: null, expiry: null, note: 'no DVSA record or lookup failed' });
    continue;
  }

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
  // PER-CAR, because a mean hides the shape. A fleet of nines and a fleet of twos-and-fifteens
  // average the same and mean completely different things for a rate.
  // WOULD THIS CAR ACTUALLY GET A RATE? Two readings is the floor, not the rule: mileageRate also
  // needs a 90-day span and readings that do not go backwards. A count alone would overstate the
  // yield, and the whole point of a dry run is to find that out before writing anything.
  const merged = [
    ...(existingReadings.get(v.id) ?? []),
    ...(data.odometerHistory ?? []).map((r) => ({ date: new Date(`${r.date}T00:00:00.000Z`), miles: r.miles })),
  ];
  // ── WHERE A MIS-KEYED READING SITS DECIDES WHETHER IT MATTERS ────────────────────────────────
  // mileageRate consults ONLY the first and last reading by date; everything between is ignored
  // entirely. So a bad value in the middle is invisible and harmless, and the same value at either
  // end silently moves the rate — or trips `goes_backwards`, which at least refuses rather than
  // inventing. BD12BVV in the first sample carried 83,672 followed by 53,672 two days apart, which
  // is plainly a keying error in the MOT record; it happened to be in the middle. This counts how
  // often that luck holds.
  // COLLAPSED BY DATE FIRST, because storage is unique on (vehicle, source, date): two MOT tests on
  // one day — a morning fail and an afternoon pass — become one row, and the pair between them is a
  // backward step that never exists in the database. Counting them inflated the first report from
  // 22 cars to 48. Analyse what will actually be stored, not what the API returned.
  const byDate = new Map();
  for (const r of [...merged].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    byDate.set(r.date.toISOString().slice(0, 10), r);
  }
  const chron = [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  const backSteps = chron.filter((r, i) => i > 0 && r.miles < chron[i - 1].miles).length;
  if (backSteps > 0) {
    anomalies.push({
      reg: v.registration, steps: backSteps,
      // An anomaly at an ENDPOINT is the one that can distort a rate that still looks plausible.
      atEnd: chron.length > 2 && (chron[1].miles < chron[0].miles || chron[chron.length - 1].miles < chron[chron.length - 2].miles),
    });
  }
  const rate = mileageRate(merged);
  if (rate.ok) rateAfter += 1; else rateRefused[rate.reason] = (rateRefused[rate.reason] ?? 0) + 1;
  perCar.push({
    reg: v.registration,
    readings: data.odometerHistory?.length ?? 0,
    expiry: data.motExpiry ?? null,
    rate: rate.ok ? `${Math.round(rate.milesPerYear)} mi/yr over ${rate.spanDays}d` : `no rate (${rate.reason})`,
    note: (data.odometerHistory?.length ?? 0) === 0 ? 'found, but no test history' : '',
  });
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
  // SCOPED TO THE SAMPLE. The first version counted the whole tenant and printed it against the
  // sampled total — "30 of 10", which is not a ratio of anything.
  const ids = vehicles.map((v) => v.id);
  let n = 0;
  for (const id of ids) if (mileageRate(existingReadings.get(id) ?? []).ok) n += 1;
  return n;
};

console.log('\n  per vehicle');
for (const c of perCar) {
  const r = c.readings === null ? '  —' : String(c.readings).padStart(3);
  console.log(`    ${c.reg.padEnd(9)} ${r} readings   ${(c.expiry ? `MOT ${c.expiry}` : '(no MOT date)').padEnd(16)} ${(c.rate ?? '').padEnd(26)} ${c.note}`);
}
const counts = perCar.filter((c) => c.readings !== null).map((c) => c.readings).sort((a, b) => a - b);
console.log(`\n  distribution       [${counts.join(', ')}]`);
console.log(`  zero readings      ${counts.filter((n) => n === 0).length} found-but-empty, ${perCar.filter((c) => c.readings === null).length} miss/failure`);

console.log(`\n  looked up          ${looked}`);
console.log(`  no DVSA record     ${missed}`);
console.log(`  errors             ${errors}`);
console.log(`  MOT dates to gain  ${gotExpiry}`);
console.log(`  cars with history  ${gotReadings}`);
console.log(`  readings to store  ${readingRows}  (${gotReadings ? (readingRows / gotReadings).toFixed(1) : 0} per car)`);
console.log(`  mot readings       ${before} → ${after}`);
// MEASURED, not counted: the real mileageRate over the real readings, existing plus incoming.
if (anomalies.length) {
  console.log(`\n  backwards readings ${anomalies.length} of ${perCar.length} cars`);
  for (const a of anomalies) {
    console.log(`    ${a.reg.padEnd(9)} ${String(a.steps).padStart(2)} backward step(s)  ${a.atEnd ? 'AT AN ENDPOINT — can move the rate' : 'mid-history — never consulted'}`);
  }
}
console.log(`\n  rate-capable NOW   ${await rateCapable()} of ${vehicles.length} sampled`);
console.log(`  rate-capable AFTER ${rateAfter} of ${vehicles.length} sampled${Object.keys(rateRefused).length ? `  (refused: ${Object.entries(rateRefused).map(([k, n]) => `${k}×${n}`).join(', ')})` : ''}`);
if (!WRITE) console.log('\n  DRY RUN — nothing was written. Re-run with --write.\n');

await prisma.$disconnect();
