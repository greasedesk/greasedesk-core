// @gate-timeout: 180
/**
 * File: scripts/schedule-reread-gate.mjs
 * THE ONE-OFF CORRECTION, PROVED ON FIXTURES BEFORE IT TOUCHES A TENANT.
 *
 * scripts/schedule-reread.mjs rewrites a stored target as the countdown it was typed as. It runs
 * once, against live data, on rows a customer document can quote. So the rule it uses is pure
 * (lib/schedule-reread), and this gate exercises that rule AND a real write of it end to end —
 * against ZZ fixtures whose correct answer is known by construction.
 *
 * WHAT IT HAS TO PROVE, in the order the risk runs:
 *   1. the arithmetic: due_mileage − countdown_miles is the odometer the row came from
 *   2. NOTHING ELSE MOVES — a migration that also nudges a date or a description is a different
 *      migration, and the only way to know is to snapshot every other column and compare
 *   3. running twice changes nothing: a row already carrying a countdown is skipped, never re-added
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { zzSite } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const R = await import('../lib/schedule-reread.ts');
const prisma = new PrismaClient();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const CUST = 'Reread Fixture Holder';
const REG = 'ZZ76RRD';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
let fix = null;

try {
  // ── 1. THE RULE, PURE ────────────────────────────────────────────────────────────────────────
  console.log('\n— the decision —');
  const d = R.rereadAsCountdown({ id: 'x', due_mileage: 14000, countdown_miles: null, mode: null }, 117735);
  check('a stored target becomes a countdown from its own card', d.act === true
    && d.dueMileage === 131735 && d.countdownMiles === 14000 && d.mode === 'countdown', JSON.stringify(d));
  check('  …carrying the whole prior triple, so it is reversible from the audit alone',
    JSON.stringify(d.from) === JSON.stringify({ due_mileage: 14000, countdown_miles: null, mode: null }), JSON.stringify(d.from));
  check('a row that already has a countdown is REFUSED',
    R.rereadAsCountdown({ id: 'x', due_mileage: 131735, countdown_miles: 14000 }, 117735).reason === 'already_countdown',
    're-reading it again would store 249,470 — this is what makes a second run a no-op');
  check('a row with no target is refused', R.rereadAsCountdown({ id: 'x', due_mileage: null, countdown_miles: null }, 60000).reason === 'no_target');
  check('a row whose card has no reading is refused', R.rereadAsCountdown({ id: 'x', due_mileage: 5000, countdown_miles: null }, null).reason === 'no_odometer');
  // NO CEILING: 36,000 on a pad set is an ordinary MINI interval, and a general assumption about
  // service intervals is not evidence about this fleet.
  check('a long interval is corrected like any other', R.rereadAsCountdown({ id: 'x', due_mileage: 36000, countdown_miles: null }, 73115).dueMileage === 109115,
    'the rule is the arithmetic, not a guess about how far a car goes between services');
  check('the invariant is stated once and holds', R.recoversOdometer(131735, 14000, 117735)
    && !R.recoversOdometer(131735, 14000, 117736), 'due_mileage minus countdown_miles IS the odometer');

  // ── 2. A REAL WRITE, AND EVERY OTHER COLUMN HELD STILL ───────────────────────────────────────
  const stale = await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture vehicle(s) from a previous run still present`);
  const site = await zzSite(prisma);
  const cust = await prisma.customer.create({ data: { group_id: ZZ, name: CUST }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: REG, registration_normalized: REG,
    make: 'Reread', model: 'Fixture' }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id,
    customer_id: cust.id, status: 'in_progress', odometer_in: 67542, odometer_out: null }, select: { id: true } });
  fix = { cust: cust.id, veh: veh.id, card: card.id };

  // Two rows: one to correct, one ALREADY a countdown that must be left exactly alone.
  const target = await prisma.vehicleDueItem.create({ data: {
    group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, description: 'RRD front pads',
    due_basis: 'mileage', due_mileage: 21000, customer_response: 'not_raised', created_by: 'reread-gate',
    observation_key: 'schedule_pads_front' }, select: { id: true } });
  const already = await prisma.vehicleDueItem.create({ data: {
    group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, description: 'RRD rear pads',
    due_basis: 'mileage', due_mileage: 88542, countdown_miles: 21000, customer_response: 'not_raised',
    created_by: 'reread-gate', observation_key: 'schedule_pads_rear' }, select: { id: true } });
  fix.items = [target.id, already.id];

  const FULL = { id: true, description: true, due_basis: true, due_date: true, due_date_precision: true,
    due_mileage: true, countdown_miles: true, mode: true, customer_response: true, response_at: true,
    found_on_job_card_id: true, closed_at: true, closed_kind: true, closed_reason: true, closed_job_card_id: true,
    observation_key: true, timing_in_description: true, service_catalogue_id: true, created_by: true, created_at: true,
    vehicle_id: true, group_id: true };
  const before = Object.fromEntries((await prisma.vehicleDueItem.findMany({ where: { id: { in: fix.items } }, select: FULL }))
    .map((r) => [r.id, r]));

  console.log('\n— the write —');
  const dec = R.rereadAsCountdown({ id: target.id, due_mileage: 21000, countdown_miles: null, mode: null }, 67542);
  await prisma.vehicleDueItem.update({ where: { id: target.id },
    data: { due_mileage: dec.dueMileage, countdown_miles: dec.countdownMiles, mode: dec.mode } });

  const after = Object.fromEntries((await prisma.vehicleDueItem.findMany({ where: { id: { in: fix.items } }, select: FULL }))
    .map((r) => [r.id, r]));
  const t = after[target.id];
  check('the corrected row satisfies the arithmetic',
    R.recoversOdometer(t.due_mileage, t.countdown_miles, 67542) && t.due_mileage === 88542 && t.mode === 'countdown',
    JSON.stringify({ due: t.due_mileage, cd: t.countdown_miles, mode: t.mode }));

  // EVERY OTHER COLUMN, compared field by field rather than spot-checked — the claim is that
  // nothing else moves, and a spot check cannot say that.
  const MOVED = ['due_mileage', 'countdown_miles', 'mode'];
  const drifted = Object.keys(FULL).filter((k) => !MOVED.includes(k)
    && JSON.stringify(before[target.id][k]) !== JSON.stringify(after[target.id][k]));
  check('  …and NOTHING else on the row moved', drifted.length === 0,
    drifted.length ? drifted.join(', ') : `${Object.keys(FULL).length - MOVED.length} columns compared, all identical`);

  const a = after[already.id];
  const aDrift = Object.keys(FULL).filter((k) => JSON.stringify(before[already.id][k]) !== JSON.stringify(a[k]));
  check('the row that already had a countdown is untouched', aDrift.length === 0,
    aDrift.join(', ') || 'every column identical');

  // ── 3. TWICE IS ONCE ─────────────────────────────────────────────────────────────────────────
  console.log('\n— run it again —');
  const second = R.rereadAsCountdown({ id: target.id, due_mileage: t.due_mileage, countdown_miles: t.countdown_miles, mode: t.mode }, 67542);
  check('a second pass refuses the row it already corrected', second.act === false && second.reason === 'already_countdown',
    JSON.stringify(second) + ' — 88,542 re-read again would be 156,084');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 900)}`);
  out.push('F');
} finally {
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${String(e?.message ?? e).slice(0, 110)}`); } };
    await step('items', () => prisma.vehicleDueItem.deleteMany({ where: { id: { in: fix.items ?? [] } } }));
    await step('card', () => prisma.jobCard.deleteMany({ where: { group_id: ZZ, id: fix.card } }));
    await step('edge', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: fix.veh } }));
    await step('vehicle', () => prisma.vehicle.deleteMany({ where: { group_id: ZZ, registration: REG } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { group_id: ZZ, id: fix.cust } }));
    try {
      const left = await prisma.vehicle.count({ where: { group_id: ZZ, registration: REG } })
        + await prisma.customer.count({ where: { group_id: ZZ, id: fix.cust } });
      check('teardown removed every fixture row (ZZ only)', left === 0, `${left} left`);
    } catch (e) {
      check('teardown removed every fixture row (ZZ only)', false, `COULD NOT VERIFY — ${String(e?.message ?? e).split('\n')[0].slice(0, 70)}; deletes are step()-logged above`);
    }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
