// Car-first re-root, STAGE C capture (read-only). Snapshots the live pre-state of exactly the
// columns Stage C alters — Vehicle / JobCard / Booking .customer_id — so any unexpected NULLing is
// restorable. The migration mutates no data, and we never delete a live Customer, so this is a pure
// safety net. Run BEFORE pushing Stage C.
//
//   node --env-file=.env prisma/scripts/capture_stage_c.js
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const CAPTURE_PATH = process.env.SC_CAPTURE_PATH || path.join(os.tmpdir(), 'stageC-weld-columns-capture.json');
const prisma = new PrismaClient();

(async () => {
  const [vehicles, jobcards, bookings] = await Promise.all([
    prisma.vehicle.findMany({ select: { id: true, customer_id: true } }),
    prisma.jobCard.findMany({ select: { id: true, customer_id: true } }),
    prisma.booking.findMany({ select: { id: true, customer_id: true } }),
  ]);
  const capture = {
    stamp: new Date().toISOString(),
    note: 'Stage C pre-state: Vehicle/JobCard/Booking.customer_id. Restore re-sets any NULLed value whose Customer still exists.',
    counts: { vehicles: vehicles.length, jobcards: jobcards.length, bookings: bookings.length },
    vehicles, jobcards, bookings,
  };
  fs.writeFileSync(CAPTURE_PATH, JSON.stringify(capture, null, 2));
  const nn = (a) => a.filter((r) => r.customer_id).length;
  console.log(`captured → vehicles:${vehicles.length}(non-null ${nn(vehicles)}) jobcards:${jobcards.length}(non-null ${nn(jobcards)}) bookings:${bookings.length}(non-null ${nn(bookings)})`);
  console.log(`capture written: ${CAPTURE_PATH}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('CAPTURE ERROR:', e.message); process.exit(1); });
