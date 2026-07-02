// Car-first re-root, STAGE C restore (data safety-net). Re-sets any Vehicle/JobCard/Booking
// .customer_id that is now NULL back to its captured value — ONLY when that Customer still exists
// (a deleted customer cannot be re-linked; on live we never delete one, so this heals accidental
// NULLing). This restores DATA; reverting the DDL (re-tighten NOT NULL / FK) is a separate reverse
// migration, printed at the end for reference.
//
//   node --env-file=.env prisma/scripts/restore_stage_c.js [--commit]
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const COMMIT = process.argv.includes('--commit');
const CAPTURE_PATH = process.env.SC_CAPTURE_PATH || path.join(os.tmpdir(), 'stageC-weld-columns-capture.json');
const prisma = new PrismaClient();

(async () => {
  if (!fs.existsSync(CAPTURE_PATH)) { console.error(`No capture at ${CAPTURE_PATH}`); process.exit(1); }
  const cap = JSON.parse(fs.readFileSync(CAPTURE_PATH, 'utf8'));
  const liveCustomers = new Set((await prisma.customer.findMany({ select: { id: true } })).map((c) => c.id));

  const plan = { vehicle: [], jobCard: [], booking: [] };
  const models = { vehicle: cap.vehicles, jobCard: cap.jobcards, booking: cap.bookings };
  for (const [model, rows] of Object.entries(models)) {
    const nowNull = new Set((await prisma[model].findMany({ where: { customer_id: null }, select: { id: true } })).map((r) => r.id));
    for (const r of rows) {
      if (r.customer_id && nowNull.has(r.id) && liveCustomers.has(r.customer_id)) plan[model].push(r);
    }
  }
  console.log(`restorable NULLed rows → vehicle:${plan.vehicle.length} jobCard:${plan.jobCard.length} booking:${plan.booking.length}`);
  if (!COMMIT) { console.log('DRY RUN — no writes. Re-run with --commit to restore.'); await prisma.$disconnect(); return; }

  await prisma.$transaction(async (tx) => {
    for (const [model, rows] of Object.entries(plan)) {
      for (const r of rows) await tx[model].update({ where: { id: r.id }, data: { customer_id: r.customer_id } });
    }
  });
  console.log('Data restore committed.');
  console.log('NOTE: to revert the DDL, run a reverse migration re-adding NOT NULL + original onDelete (Vehicle=CASCADE, JobCard/Booking=NO ACTION).');
  await prisma.$disconnect();
})().catch((e) => { console.error('RESTORE ERROR:', e.message); process.exit(1); });
