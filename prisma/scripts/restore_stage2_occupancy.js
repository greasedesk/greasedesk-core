// Occupancy footprint STAGE 2 restore (panic button). Reverts the 6 booked cards to the captured
// pre-state: {start_at, end_at, resource_id, booking_duration_minutes}. Undoes the backfill's end_at
// re-derivation AND the L100BKY Lift1->Lift2 move.
//
//   node --env-file=.env prisma/scripts/restore_stage2_occupancy.js [--commit]
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const COMMIT = process.argv.includes('--commit');
const CAPTURE_PATH = process.env.S2_CAPTURE || path.join(os.tmpdir(), 'stage2-occupancy-capture.json');
const p = new PrismaClient();

(async () => {
  if (!fs.existsSync(CAPTURE_PATH)) { console.error(`No capture at ${CAPTURE_PATH}`); process.exit(1); }
  const cap = JSON.parse(fs.readFileSync(CAPTURE_PATH, 'utf8'));
  console.log(`Would restore ${cap.cards.length} cards to pre-state:`);
  for (const c of cap.cards) console.log(`  ${c.reg.padEnd(8)} lift=${c.resource_id?.slice(0, 8)} end=${c.end_at.slice(0, 16)} dur=${c.booking_duration_minutes ?? 'NULL'}`);
  if (!COMMIT) { console.log('\nDRY RUN — no writes. Re-run with --commit to restore.'); await p.$disconnect(); return; }

  await p.$transaction(async (tx) => {
    for (const c of cap.cards) {
      await tx.jobCard.update({
        where: { id: c.id },
        data: { start_at: new Date(c.start_at), end_at: new Date(c.end_at), resource_id: c.resource_id, booking_duration_minutes: c.booking_duration_minutes },
      });
    }
  });
  console.log('Restore committed — booked cards reverted to captured pre-state.');
  await p.$disconnect();
})().catch((e) => { console.error('RESTORE ERROR:', e.message); process.exit(1); });
