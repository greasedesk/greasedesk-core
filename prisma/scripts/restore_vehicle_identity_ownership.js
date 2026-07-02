// Car-first re-root, STAGE A restore (undo the backfill; DDL stays, data reverts).
//
//   node --env-file=.env prisma/scripts/restore_vehicle_identity_ownership.js [--commit]
//
// Reverses ONLY what the backfill added: deletes every VehicleOwnership + VehicleIdentity row and
// NULLs Vehicle.identity_id / vin_normalized back to the captured pre-state. It asserts that every
// Vehicle.customer_id is byte-identical to the capture BEFORE touching anything — if the weld moved,
// it refuses. This is the panic button for Stage A; the tables/columns (DDL) remain.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const COMMIT = process.argv.includes('--commit');
const CAPTURE_PATH = process.env.CAPTURE_PATH || path.join(os.tmpdir(), 'stageA-vehicle-weld-capture.json');
const prisma = new PrismaClient();

(async () => {
  if (!fs.existsSync(CAPTURE_PATH)) { console.error(`No capture at ${CAPTURE_PATH} — cannot verify weld before restore.`); process.exit(1); }
  const capture = JSON.parse(fs.readFileSync(CAPTURE_PATH, 'utf8'));
  const want = new Map(capture.vehicles.map((v) => [v.vehicle_id, v.customer_id]));

  const now = await prisma.vehicle.findMany({ select: { id: true, customer_id: true } });
  const drift = now.filter((v) => want.has(v.id) && want.get(v.id) !== v.customer_id);
  if (drift.length) {
    console.error(`WELD DRIFT on ${drift.length} vehicle(s) — customer_id differs from capture. Refusing to restore.`);
    drift.forEach((v) => console.error(`  ${v.id}: now=${v.customer_id} captured=${want.get(v.id)}`));
    process.exit(1);
  }
  console.log(`Weld intact across ${now.length} vehicles (customer_id matches capture).`);

  const owns = await prisma.vehicleOwnership.count();
  const ids = await prisma.vehicleIdentity.count();
  console.log(`Would delete: ${owns} ownership edge(s), ${ids} identity row(s); NULL identity_id/vin_normalized on all vehicles.`);
  if (!COMMIT) { console.log('\nDRY RUN — no writes. Re-run with --commit to restore.'); await prisma.$disconnect(); return; }

  await prisma.$transaction(async (tx) => {
    await tx.vehicleOwnership.deleteMany({});
    await tx.vehicle.updateMany({ data: { identity_id: null, vin_normalized: null } });
    await tx.vehicleIdentity.deleteMany({});
  });
  console.log('Restore committed. Weld unchanged; identity/ownership layer emptied.');
  await prisma.$disconnect();
})().catch((e) => { console.error('RESTORE ERROR:', e.message); process.exit(1); });
