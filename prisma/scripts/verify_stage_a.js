// Car-first re-root, STAGE A prod-verify (read-only).
//
//   node --env-file=.env prisma/scripts/verify_stage_a.js
//
// PASS criteria (all must be green):
//   1. Every Vehicle has identity_id set (no orphan vehicle).
//   2. Every Vehicle has EXACTLY ONE current ownership edge.
//   3. That edge's customer_id == the vehicle's (still-live) customer_id weld.
//   4. No vehicle has >1 current edge (partial-unique guard holds).
//   5. vin_normalized on the vehicle matches its identity's vin_normalized.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const vehicles = await prisma.vehicle.findMany({
    select: {
      id: true, customer_id: true, identity_id: true, vin_normalized: true,
      identity: { select: { vin_normalized: true } },
      ownerships: { where: { is_current: true }, select: { customer_id: true } },
    },
  });

  const noIdentity = vehicles.filter((v) => !v.identity_id);
  const noCurrent  = vehicles.filter((v) => v.ownerships.length === 0);
  const multiCurrent = vehicles.filter((v) => v.ownerships.length > 1);
  const weldMismatch = vehicles.filter((v) => v.ownerships.length === 1 && v.ownerships[0].customer_id !== v.customer_id);
  const vinMismatch = vehicles.filter((v) => (v.vin_normalized || null) !== (v.identity?.vin_normalized || null));

  const idCount = await prisma.vehicleIdentity.count();
  const edgeCount = await prisma.vehicleOwnership.count();
  const currentEdges = await prisma.vehicleOwnership.count({ where: { is_current: true } });

  console.log(`Vehicles: ${vehicles.length} | VehicleIdentity rows: ${idCount} | ownership edges: ${edgeCount} (current: ${currentEdges})`);
  console.log(`  [1] vehicles missing identity_id ......... ${noIdentity.length}   (expect 0)`);
  console.log(`  [2] vehicles missing a current edge ...... ${noCurrent.length}   (expect 0)`);
  console.log(`  [3] current-edge owner != weld customer .. ${weldMismatch.length}   (expect 0)`);
  console.log(`  [4] vehicles with >1 current edge ........ ${multiCurrent.length}   (expect 0)`);
  console.log(`  [5] vehicle vin_normalized != identity ... ${vinMismatch.length}   (expect 0)`);

  const fails = [noIdentity, noCurrent, weldMismatch, multiCurrent, vinMismatch].some((a) => a.length);
  [noIdentity, noCurrent, weldMismatch, multiCurrent, vinMismatch].forEach((arr, i) =>
    arr.slice(0, 5).forEach((v) => console.log(`    check#${i + 1} offending vehicle ${v.id}`)));
  console.log(fails ? '\nSTAGE A VERIFY: FAIL' : '\nSTAGE A VERIFY: PASS ✅');
  await prisma.$disconnect();
  if (fails) process.exit(1);
})().catch((e) => { console.error('VERIFY ERROR:', e.message); process.exit(1); });
