/**
 * File: scripts/schedule-reread.mjs
 * ONE-OFF. Re-read every stored schedule target as the countdown it was typed as.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write. See lib/schedule-reread for the rule and
 * scripts/schedule-reread-gate for the proof of it against fixtures.
 *
 *   node scripts/schedule-reread.mjs              # report what it would do
 *   node scripts/schedule-reread.mjs --apply      # do it
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { PrismaClient } = await import('@prisma/client');
const R = await import('../lib/schedule-reread.ts');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';

const ssr = await prisma.serviceScheduleReading.findMany({
  where: { group_id: TMBS, due_mileage: { not: null } },
  select: { id: true, item_key: true, due_mileage: true, countdown_miles: true, mode: true, job_card_id: true },
});
const vdi = await prisma.vehicleDueItem.findMany({
  where: { group_id: TMBS, due_mileage: { not: null }, found_on_job_card_id: { not: null } },
  select: { id: true, observation_key: true, description: true, due_mileage: true, countdown_miles: true, mode: true, found_on_job_card_id: true },
});
const work = [
  ...ssr.map((r) => ({ table: 'ServiceScheduleReading', model: 'serviceScheduleReading', row: r, card: r.job_card_id, item: r.item_key })),
  ...vdi.map((r) => ({ table: 'VehicleDueItem', model: 'vehicleDueItem', row: r, card: r.found_on_job_card_id, item: r.observation_key ?? r.description })),
];
const cards = Object.fromEntries((await prisma.jobCard.findMany({
  where: { id: { in: [...new Set(work.map((w) => w.card))] } },
  select: { id: true, odometer_in: true, odometer_out: true, vehicle: { select: { registration: true } } },
})).map((c) => [c.id, c]));

let applied = 0, skipped = 0;
const skips = {};
console.log(APPLY ? '\n=== APPLYING ===\n' : '\n=== DRY RUN — nothing will be written (pass --apply) ===\n');

for (const w of work) {
  const c = cards[w.card];
  // ODOMETER-OUT FIRST, matching the departure stage's own precedence — the reading on THIS card,
  // never today's for that car, which has moved since.
  const odo = c?.odometer_out ?? c?.odometer_in ?? null;
  const source = c?.odometer_out != null ? 'odometer_out' : 'odometer_in';
  const d = R.rereadAsCountdown(w.row, odo);
  if (!d.act) { skipped++; skips[d.reason] = (skips[d.reason] ?? 0) + 1; continue; }

  console.log(`${(c?.vehicle?.registration ?? '?').padEnd(8)} ${w.table === 'VehicleDueItem' ? 'VDI' : 'SSR'} ${String(w.item).padEnd(22)} ${String(d.from.due_mileage).padStart(6)} → ${String(d.dueMileage).padStart(7)}  (${source} ${odo})`);
  if (!APPLY) { applied++; continue; }

  // ONE TRANSACTION PER ROW: the correction and the record of it cannot come apart, and a failure
  // part-way leaves corrected rows each with their own trail rather than a silent partial run.
  await prisma.$transaction(async (tx) => {
    await tx[w.model].update({ where: { id: w.row.id },
      data: { due_mileage: d.dueMileage, countdown_miles: d.countdownMiles, mode: d.mode } });
    await tx.auditLog.create({ data: {
      group_id: TMBS, entity: 'JobCard', entity_id: w.card, action: 'schedule.reread_as_countdown',
      diff_json: {
        by: 'direct database write, not the API',
        reason: 'stored as an absolute target under a form that offered two conventions; every mileage figure on this tenant sits BELOW its own car\'s reading, which no real target does — these are intervals read off a cluster and stored as odometer positions',
        item: w.item,
        source_table: w.table,
        row_id: w.row.id,
        odometer: odo,
        odometer_source: source,
        from: d.from,
        to: { due_mileage: d.dueMileage, countdown_miles: d.countdownMiles, mode: d.mode },
        reversible: 'yes — due_mileage minus countdown_miles is the odometer it was derived from',
      },
    } });
  });
  applied++;
}
console.log(`\n${APPLY ? 'corrected' : 'would correct'}: ${applied}    skipped: ${skipped} ${JSON.stringify(skips)}`);
await prisma.$disconnect();
