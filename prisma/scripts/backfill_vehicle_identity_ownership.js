// Car-first re-root, STAGE A backfill (capture-first, idempotent).
//
//   node --env-file=.env prisma/scripts/backfill_vehicle_identity_ownership.js [--commit]
//
// Without --commit it is a DRY RUN: captures the pre-state, prints what it WOULD do, writes nothing.
// With --commit it writes the capture file first, then backfills inside one transaction.
//
// It touches only currently-empty nullable columns (Vehicle.identity_id / vin_normalized) and INSERTs
// new rows (VehicleIdentity, VehicleOwnership). It NEVER writes Vehicle.customer_id — the weld is left
// exactly as found and stays the source of truth through Stage A. Idempotent: a vehicle that already
// has an identity and a current ownership edge is skipped, so re-runs and post-deploy dual-writes are safe.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const COMMIT = process.argv.includes('--commit');
const CAPTURE_PATH = process.env.CAPTURE_PATH || path.join(os.tmpdir(), 'stageA-vehicle-weld-capture.json');
const prisma = new PrismaClient();

const normVin = (vin) => {
  const n = (vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n.length ? n : null;
};

(async () => {
  const vehicles = await prisma.vehicle.findMany({
    select: { id: true, group_id: true, customer_id: true, registration: true, vin: true,
              identity_id: true, vin_normalized: true, created_at: true },
    orderBy: { created_at: 'asc' },
  });

  // CAPTURE the weld pre-state (vehicle_id -> customer_id + the currently-empty columns) for restore.
  const capture = {
    stamp: new Date().toISOString(),
    note: 'Stage A pre-backfill snapshot. Restore target: customer_id must be identical afterwards.',
    vehicles: vehicles.map((v) => ({
      vehicle_id: v.id, group_id: v.group_id, customer_id: v.customer_id,
      registration: v.registration, vin: v.vin,
      identity_id_before: v.identity_id, vin_normalized_before: v.vin_normalized,
    })),
  };

  const todo = vehicles.filter((v) => !v.identity_id); // idempotent: skip already-backfilled
  console.log(`Vehicles: ${vehicles.length} | need backfill: ${todo.length} | already linked: ${vehicles.length - todo.length}`);
  for (const v of todo) {
    console.log(`  ${v.id}  reg=${v.registration}  vin=${v.vin || '—'} -> vin_normalized=${normVin(v.vin) || 'NULL'}  owner=${v.customer_id}`);
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — no writes. Capture would be written to:\n  ${CAPTURE_PATH}\nRe-run with --commit to apply.`);
    await prisma.$disconnect();
    return;
  }

  fs.writeFileSync(CAPTURE_PATH, JSON.stringify(capture, null, 2));
  console.log(`\nCapture written: ${CAPTURE_PATH}`);

  let identitiesMade = 0, edgesMade = 0;
  await prisma.$transaction(async (tx) => {
    for (const v of todo) {
      const vn = normVin(v.vin);
      // One identity per vehicle now (1:1); when a VIN is present reuse this tenant's existing
      // identity for that VIN (respects @@unique([group_id, vin_normalized])). Blank VIN -> fresh row.
      let identity = vn
        ? await tx.vehicleIdentity.findFirst({ where: { group_id: v.group_id, vin_normalized: vn } })
        : null;
      if (!identity) {
        identity = await tx.vehicleIdentity.create({
          data: { group_id: v.group_id, vin_normalized: vn, registration: v.registration, created_at: v.created_at },
          select: { id: true },
        });
        identitiesMade++;
      }
      await tx.vehicle.update({ where: { id: v.id }, data: { identity_id: identity.id, vin_normalized: vn } });

      const hasCurrent = await tx.vehicleOwnership.findFirst({ where: { vehicle_id: v.id, is_current: true } });
      if (!hasCurrent) {
        await tx.vehicleOwnership.create({
          data: { vehicle_id: v.id, customer_id: v.customer_id, is_current: true, valid_from: v.created_at },
        });
        edgesMade++;
      }
    }
  });
  console.log(`\nBackfill committed. identities created: ${identitiesMade} | current edges created: ${edgesMade}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('BACKFILL ERROR:', e.message); process.exit(1); });
