// Occupancy BREAKS Stage 2 restore (panic button). Reverts Great Bridge's breaks to the captured
// pre-state (NULL) and the moved bookings' end_at to their captured pre-break values.
//   node --env-file=.env prisma/scripts/restore_stage2_breaks.js [--commit]
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const COMMIT = process.argv.includes('--commit');
const CAPTURE_PATH = process.env.S2B_CAPTURE || path.join(os.tmpdir(), 'stage2-breaks-capture.json');
const p = new PrismaClient();

(async () => {
  if (!fs.existsSync(CAPTURE_PATH)) { console.error(`No capture at ${CAPTURE_PATH}`); process.exit(1); }
  const cap = JSON.parse(fs.readFileSync(CAPTURE_PATH, 'utf8'));
  console.log(`Would restore site ${cap.siteId.slice(0, 8)} breaks -> ${JSON.stringify(cap.siteBreaksBefore)} and ${cap.cards.length} cards' end_at:`);
  for (const c of cap.cards) console.log(`  ${c.reg.padEnd(9)} end_at -> ${c.end_at.slice(0, 16)}`);
  if (!COMMIT) { console.log('\nDRY RUN — no writes. Re-run with --commit to restore.'); await p.$disconnect(); return; }

  await p.$transaction(async (tx) => {
    await tx.site.update({ where: { id: cap.siteId }, data: { breaks: cap.siteBreaksBefore } });
    for (const c of cap.cards) await tx.jobCard.update({ where: { id: c.id }, data: { end_at: new Date(c.end_at) } });
  });
  console.log('Restore committed — break cleared, end_at reverted.');
  await p.$disconnect();
})().catch((e) => { console.error('RESTORE ERROR:', e.message); process.exit(1); });
