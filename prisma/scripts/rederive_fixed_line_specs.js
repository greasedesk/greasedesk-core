// Re-derive existing fixed-price JobCardItem line labels from the product's Title + Description
// (the corrected model), replacing the old concatenated-COMPONENT text that leaked internal cost
// labels (e.g. "Roy's MOT Fee"). Components stay untouched — they remain the margin source.
//
//   node --env-file=.env prisma/scripts/rederive_fixed_line_specs.js            # DRY RUN (default)
//   node --env-file=.env prisma/scripts/rederive_fixed_line_specs.js --commit   # capture-first, then write
//   node --env-file=.env prisma/scripts/rederive_fixed_line_specs.js --restore  # revert from the capture
//
// Safety: only touches item_type='fixed' lines that have a catalogue_item_id (so a Title/Description
// source exists) AND whose card has NO issued Invoice (issued customer docs are frozen snapshots).
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const COMMIT = process.argv.includes('--commit');
const RESTORE = process.argv.includes('--restore');
const CAPTURE_PATH = process.env.RDR_CAPTURE || path.join(os.tmpdir(), 'fixed-spec-rederive-capture.json');
const p = new PrismaClient();

// MIRROR of lib/catalogue.ts::fixedLineText — keep in sync.
function fixedLineText(title, description, code) {
  const spec = (description || '').trim();
  const head = (title || '').trim();
  if (head && head !== spec) return spec ? `${head}\n${spec}` : head;
  return spec || head || (code || '').trim();
}

(async () => {
  if (RESTORE) {
    if (!fs.existsSync(CAPTURE_PATH)) { console.error(`No capture at ${CAPTURE_PATH}`); process.exit(1); }
    const cap = JSON.parse(fs.readFileSync(CAPTURE_PATH, 'utf8'));
    console.log(`Restoring ${cap.lines.length} line descriptions from capture ${cap.stamp}`);
    await p.$transaction(async (tx) => { for (const l of cap.lines) await tx.jobCardItem.update({ where: { id: l.id }, data: { description: l.before } }); });
    console.log('Restore committed.');
    await p.$disconnect(); return;
  }

  // Fixed lines with a catalogue origin, on cards with no issued invoice.
  const lines = await p.jobCardItem.findMany({
    where: { item_type: 'fixed', catalogue_item_id: { not: null }, job_card: { invoice: { is: null } } },
    select: {
      id: true, description: true, catalogue_item_id: true,
      catalogue: { select: { code: true, title: true, name: true, item_type: true } },
      job_card: { select: { id: true } },
    },
  });

  const plan = [];
  for (const l of lines) {
    const c = l.catalogue;
    if (!c || c.item_type !== 'fixed') continue;
    const next = fixedLineText(c.title, c.name, c.code);
    if (next !== l.description) plan.push({ id: l.id, code: c.code, before: l.description, after: next });
  }

  // Also report fixed lines we are NOT touching (no catalogue origin, or issued invoice) for visibility.
  const untouchable = await p.jobCardItem.count({ where: { item_type: 'fixed', OR: [{ catalogue_item_id: null }, { job_card: { invoice: { isNot: null } } }] } });

  console.log(`=== RE-DERIVE PLAN (${plan.length} of ${lines.length} eligible fixed lines change) ===`);
  for (const x of plan) console.log(`  [${x.code}] ${JSON.stringify(x.before)}  ->  ${JSON.stringify(x.after)}`);
  console.log(`  (skipped ${untouchable} fixed lines with no catalogue origin or an issued invoice)`);

  if (!COMMIT) { console.log(`\nDRY RUN — no writes. --commit to apply (capture -> ${CAPTURE_PATH}).`); await p.$disconnect(); return; }
  if (plan.length === 0) { console.log('\nNothing to change.'); await p.$disconnect(); return; }

  fs.writeFileSync(CAPTURE_PATH, JSON.stringify({ stamp: new Date().toISOString(), lines: plan }, null, 2));
  console.log(`\nCapture written: ${CAPTURE_PATH}`);
  await p.$transaction(async (tx) => { for (const x of plan) await tx.jobCardItem.update({ where: { id: x.id }, data: { description: x.after } }); });
  console.log(`Committed: ${plan.length} fixed line labels re-derived. --restore to revert.`);
  await p.$disconnect();
})().catch((e) => { console.error('RE-DERIVE ERROR:', e.message); process.exit(1); });
