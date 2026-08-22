/**
 * File: scripts/demo-refresh.mjs
 * REGENERATE a sales-demo tenant. Destructive, declared-target-only, dry by default.
 *
 *   node scripts/demo-refresh.mjs --create           > /tmp/d.log 2>&1   # first generation
 *   node scripts/demo-refresh.mjs --group=GB-GDxxxx  > /tmp/d.log 2>&1   # dry run: what it WOULD do
 *   node scripts/demo-refresh.mjs --group=GB-GDxxxx --apply > /tmp/d.log 2>&1
 *
 * ── WHY REGENERATE AND NOT DATE-SHIFT ───────────────────────────────────────────────────────────
 * A delta-shift has to move every dated column — job cards, invoices, payments, refunds, credit
 * notes, quote versions, threads — and then it meets AuditLog, which is APPEND-ONLY by standing
 * rule. It either mutates an append-only table or leaves the audit trail disagreeing with every
 * document date. Neither is acceptable, in a demo or anywhere. Regeneration sidesteps it: the new
 * tenant's audit rows are written by the generator, in step with everything else.
 *
 * It also avoids re-deciding, per column, what a shift means for `collected_at` and period
 * attribution — the exact questions that took a day to settle for real tenants.
 *
 * ── STRUCTURALLY UNABLE TO POINT AT A CUSTOMER ──────────────────────────────────────────────────
 * The target must be DECLARED in lib/demo-tenants::DEMO_TENANTS **and** still be `is_internal` in
 * the database. Two independent conditions: a list entry is a claim written once, `is_internal` is
 * the fact that makes it true, checked at the moment of use. Neither alone authorises a wipe.
 *
 * Marketbridge (GB-GD2236) is deliberately NOT listed: it is the frozen reference demo, it is
 * is_demo, it is under a standing hold, and a refresh pointed at it would destroy the recording set.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { DEMO_TENANTS, refuseRefresh } = await import('../lib/demo-tenants.ts');
const { generateDemoTenant } = await import('../lib/demo/generate.ts');
const bcrypt = (await import('bcryptjs')).default;

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const APPLY = process.argv.includes('--apply');
const CREATE = process.argv.includes('--create');

/**
 * The DEMO TENANT'S own number, owner-supplied. This is what a prospect reads in every demo text:
 * the SMS suffix renders "To reply, call 03305553333", so it must be a line somebody is content to
 * have rung.
 *
 * NOT the same thing as the CUSTOMER numbers in the generated data — those stay on Ofcom's reserved
 * drama range (01632 960xxx), unroutable, so the seeded rows can never text a real person even
 * though this tenant is is_demo = false and its sends are not blocked.
 */
const DEMO_PHONE = '03305553333';
const DEMO_NAME = 'Kingsford Motor Company';
const DEMO_OWNER = 'demo@greasedesk.com';

/**
 * THE ONE REAL NUMBER in the tenant, owner-supplied. Kept here rather than in lib/demo/profile.ts,
 * which scripts/demo-profile-extract.mjs rewrites wholesale and would delete.
 */
const DEMO_SUBJECT = { name: 'Hugh Gunn', phone: '07397387332' };

if (CREATE) {
  console.log('CREATE — generating a fresh sales-demo tenant.\n');
  const res = await generateDemoTenant({
    seed: `sales-demo-${new Date().toISOString().slice(0, 10)}`,
    now: new Date(),
    groupName: DEMO_NAME,
    ownerEmail: DEMO_OWNER,
    ownerName: 'Demo Owner',
    ownerPasswordHash: bcrypt.hashSync(process.env.DEMO_PASSWORD || 'ChangeMe!2026', 10),
    expiresAt: null,
    // FALSE, deliberately. demoSendDecision blocks every send from an is_demo tenant and its only
    // exception matches the owner's EMAIL — an SMS recipient is a phone number and can never match,
    // so a demo that shows a text arriving cannot be is_demo. Safe because the generator seeds
    // Ofcom's drama range for every customer number: unroutable regardless of the flag.
    isDemo: false,
    groupPhone: DEMO_PHONE,
    demoSubject: DEMO_SUBJECT,
    onProgress: (s, d) => console.log(`  ${s}${d ? ` — ${d}` : ''}`),
  });
  const g = await prisma.group.findUnique({ where: { id: res.groupId }, select: { ref: true, is_demo: true, is_internal: true, phone: true } });
  console.log(`\ncreated ${g.ref}  is_demo=${g.is_demo}  is_internal=${g.is_internal}  phone=${g.phone}`);
  console.log(`owner login: ${DEMO_OWNER}`);
  console.log(`\nADD THIS TO lib/demo-tenants::DEMO_TENANTS, or refresh will refuse it:\n`);
  console.log(`  { ref: '${g.ref}', purpose: 'Shared sales demo — reps get their own User rows here.' },`);
  await prisma.$disconnect();
  process.exit(0);
}

const ref = arg('group');
if (!ref) { console.log('Usage: --create, or --group=<ref> [--apply]'); await prisma.$disconnect(); process.exit(2); }

// Resolve BY REF, never findFirst-by-name: groups legitimately share names.
const target = await prisma.group.findFirst({ where: { ref }, select: { id: true, ref: true, group_name: true, is_internal: true, is_demo: true } });
const refusal = refuseRefresh(ref, target);
if (refusal) {
  console.log(`REFUSING (${refusal.code})\n\n  ${refusal.message}\n`);
  console.log(`Declared demo tenants: ${DEMO_TENANTS.length ? DEMO_TENANTS.map((t) => t.ref).join(', ') : '(none yet — run --create)'}`);
  await prisma.$disconnect();
  process.exit(2);
}

// What regeneration destroys, counted BEFORE anything is touched so the operator sees the price.
const counts = {
  job_cards: await prisma.jobCard.count({ where: { group_id: target.id } }),
  customers: await prisma.customer.count({ where: { group_id: target.id } }),
  invoices: await prisma.invoice.count({ where: { group_id: target.id } }),
  payments: await prisma.payment.count({ where: { group_id: target.id } }),
};
console.log(`${target.ref} ${target.group_name} — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  would destroy: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
// ── GENERATE, VERIFY, SWAP, THEN DESTROY ────────────────────────────────────────────────────────
// DESTROY IS LAST. The obvious order — purge the old tenant then regenerate — puts a 27-minute
// non-transactional generation AFTER the only irreversible step, so any failure in it leaves the
// demo absent rather than stale, with no way back: no soft delete on this path, and the ref gone
// for good (see the sequence note below). Generating first costs a second tenant for half an hour
// and makes every failure recoverable, because the old one is still there until step 5.
const epoch = Date.now();

// ── THE STAGING IDENTITY ──────────────────────────────────────────────────────────────────────
// THREE columns are globally unique and the live tenant is holding all three while we generate:
// Group.ref, Group.billing_email, and User.email — the last one is unique across the whole
// platform, not per tenant. Generating under the real identity fails on the first group.create,
// about four seconds in. So the new tenant is built under names nobody is using and takes the real
// ones in the swap.
//
// ── THE NAME IS *NOT* STAGED, AND THAT IS THE CORRECTION ────────────────────────────────────
// The first build gave the staging tenant a distinguishable name, to avoid two "Kingsford Motor
// Company" rows in the superadmin list — the shared-identifier problem that made the Gateholm
// purge resolve by ref. Right instinct, wrong column.
//
// group_name is FROZEN INTO EVERY INVOICE AT MINT (company_name_snapshot, and the trading name
// beside it), inside the generation that runs before any swap. It is not a live setting that can
// be moved afterwards: the first run produced 800 invoices all reading "Kingsford Motor Company
// (staging 1787406411137)", and a snapshot is not rewritable — that is the whole point of freezing
// it. A demo whose every document carries a build artefact is not a demo.
//
// So the replacement is generated under the REAL name and the two tenants are told apart by the
// things that never reach a document: `ref` (the staging one takes the next sequence value) and
// `billing_email`. The Gateholm risk was choosing the wrong tenant to DESTROY, and that is already
// closed by construction — the purge targets `target.id`, captured before generation began, so it
// cannot resolve by name even if it wanted to.
const stagingEmail = `demo+staging-${epoch}@greasedesk.com`;
const stagingName = DEMO_NAME;

console.log(`\nSTAGING IDENTITY (the new tenant is built under these, then takes the real ones)`);
console.log(`  name          ${stagingName}   (the REAL name — it is frozen into every invoice at mint)`);
console.log(`  billing_email ${stagingEmail}`);
console.log(`  owner email   ${stagingEmail}`);
console.log(`  ref           (natural sequence value)`);
console.log(`\nTHEN THREE RELEASE/TAKE PAIRS, one transaction:`);
console.log(`  ref            ${target.ref} : old → 'GB-GD…-superseded-${epoch}', new → ${target.ref}`);
console.log(`  billing_email  ${DEMO_OWNER} : old → tombstone, new → ${DEMO_OWNER}`);
console.log(`  owner email    ${DEMO_OWNER} : old → tombstone, new → ${DEMO_OWNER}`);
console.log(`\nTHEN purgeTenant on the OLD group ${target.id} (${target.ref})`);
console.log(`\nVERIFY BEFORE ANY OF THAT — the swap does not start unless all seven pass:`);
for (const line of [
  'generation returned a group id',
  'vehicle count within range of the old tenant',
  'job-card count within range of the old tenant',
  'the board returns a non-zero Hot stack',
  '  …and non-zero Warm and Later — Hot alone passes a tenant where only the MOT bands wrote',
  'the owner user resolves by the staging email (the swap moves it; absent means it moves nothing)',
  'every invoice with a ledger matches it (lib/payments::expectedCachePennies)',
  'the invoice series is gapless and has no duplicate numbers',
]) console.log(`  · ${line}`);

if (!APPLY) {
  console.log('\nDry run. Nothing generated, nothing swapped, nothing destroyed.');
  await prisma.$disconnect();
  process.exit(0);
}

const { purgeTenant } = await import('../lib/tenant-purge.ts');
const { expectedCachePennies } = await import('../lib/payments.ts');
const { buildBoard } = await import('../lib/marketing-board.ts');

// ── 1. GENERATE ───────────────────────────────────────────────────────────────────────────────
console.log('\n— generating the replacement (the old tenant is untouched throughout) —');
const t0 = Date.now();
let fresh = null;
try {
  fresh = await generateDemoTenant({
    seed: `sales-demo-${new Date().toISOString().slice(0, 10)}-${epoch}`,
    now: new Date(),
    groupName: stagingName,
    ownerEmail: stagingEmail,
    ownerName: 'Demo Owner',
    ownerPasswordHash: bcrypt.hashSync(process.env.DEMO_PASSWORD || 'ChangeMe!2026', 10),
    expiresAt: null,
    isDemo: false,
    groupPhone: DEMO_PHONE,
    demoSubject: DEMO_SUBJECT,
    onProgress: (st, d) => console.log(`  ${st}${d ? ` — ${d}` : ''}`),
  });
} catch (e) {
  console.log(`\nGENERATION FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${String(e?.message ?? e).slice(0, 300)}`);
  console.log(`${target.ref} is UNTOUCHED. A partial staging tenant may exist — find it by the name above and purge it by id.`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`\ngenerated in ${Math.round((Date.now() - t0) / 1000)}s`);

// ── 2. VERIFY ─────────────────────────────────────────────────────────────────────────────────
// RANGES AND INVARIANTS, never fixed numbers: the counts move with the profile and with `now`, so
// a pinned figure would fail for the wrong reason on the first calibration change.
const problems = [];
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) problems.push(name);
};
console.log('\n— verifying before anything moves —');
ok('generation returned a group id', !!fresh?.groupId, fresh?.groupId ?? 'none');

const oldCounts = counts;
const newVeh = await prisma.vehicle.count({ where: { group_id: fresh.groupId } });
const newCards = await prisma.jobCard.count({ where: { group_id: fresh.groupId } });
const within = (n, ref, lo = 0.5, hi = 1.8) => n >= Math.floor(ref * lo) && n <= Math.ceil(ref * hi);
const oldVeh = await prisma.vehicle.count({ where: { group_id: target.id } });
ok('vehicle count is within range of the old tenant', within(newVeh, oldVeh), `${newVeh} vs ${oldVeh}`);
ok('job-card count is within range of the old tenant', within(newCards, oldCounts.job_cards), `${newCards} vs ${oldCounts.job_cards}`);

const board = await buildBoard(fresh.groupId, new Date());
ok('the board returns a non-zero Hot stack', board.hot.length > 0, `hot=${board.hot.length}`);
// HOT ALONE IS NOT ENOUGH. A tenant where only the MOT bands wrote and every createMany silently
// no-opped still produces a Hot stack — the expired cars alone. Warm and Later are what prove the
// findings, readings and contacts actually landed.
ok('  …and Warm and Later are non-zero too', board.warm.length > 0 && board.later.length > 0,
  `warm=${board.warm.length} later=${board.later.length}`);

const owner = await prisma.user.findUnique({ where: { email: stagingEmail }, select: { id: true, group_id: true } });
ok('the owner user resolves by the staging email', !!owner && owner.group_id === fresh.groupId,
  owner ? `user ${owner.id}` : 'ABSENT — the swap would move nothing');

// The money is COHERENT, not merely present: the same rule payment-invariant-gate applies.
const invs = await prisma.invoice.findMany({ where: { group_id: fresh.groupId }, select: { id: true, amount_paid_pennies: true, invoice_number: true, series: true } });
const pays = await prisma.payment.findMany({ where: { group_id: fresh.groupId }, select: { invoice_id: true, status: true, amount_pennies: true } });
const byInv = new Map();
for (const pmt of pays) { const a = byInv.get(pmt.invoice_id) ?? []; a.push(pmt); byInv.set(pmt.invoice_id, a); }
const drift = invs.filter((inv) => {
  const ps = byInv.get(inv.id) ?? [];
  return ps.length > 0 && inv.amount_paid_pennies !== expectedCachePennies(ps, []);
});
ok('every invoice with a ledger matches it', drift.length === 0, `${drift.length} drifted of ${invs.length}`);

// GAPLESS is a VAT property and it is cheap to assert here rather than discover on a document.
const chargeable = invs.filter((i) => i.series === 'chargeable').map((i) => Number(i.invoice_number)).sort((a, b) => a - b);
const dupes = chargeable.length - new Set(chargeable).size;
const gaps = chargeable.length ? chargeable[chargeable.length - 1] - chargeable[0] + 1 - chargeable.length : 0;
ok('the chargeable series is gapless with no duplicates', dupes === 0 && gaps === 0, `${dupes} duplicate(s), ${gaps} gap(s) across ${chargeable.length}`);

// THE NAME ON THE DOCUMENTS, not on the group row. Checked here because it CANNOT be corrected
// later: it is frozen at mint, and the first build shipped 800 invoices carrying a staging name
// that the swap had no way to reach. A group row can be renamed; eight hundred snapshots cannot.
const wrongName = await prisma.invoice.count({
  where: { group_id: fresh.groupId, NOT: { company_name_snapshot: DEMO_NAME } } });
ok('every invoice snapshot carries the real company name', wrongName === 0,
  wrongName ? `${wrongName} of ${invs.length} carry something else` : `${invs.length} invoices, all "${DEMO_NAME}"`);

if (problems.length) {
  console.log(`\nVERIFICATION FAILED (${problems.length}). NOTHING HAS MOVED.`);
  console.log(`${target.ref} is intact. The staging tenant ${fresh.groupId} is complete but unswapped — inspect it, then purge it by id.`);
  await prisma.$disconnect();
  process.exit(1);
}

// ── 3. THE GUARD, AGAIN, ON A FRESH READ ──────────────────────────────────────────────────────
// Twenty-seven minutes have passed since the first check. The swap is where the old tenant's
// identity starts moving, so this is the last honest moment to ask whether it is still a thing we
// are allowed to touch — someone may have cleared is_internal while the generator ran.
const stillTarget = await prisma.group.findFirst({ where: { ref: target.ref }, select: { id: true, ref: true, group_name: true, is_internal: true, is_demo: true } });
const stillRefused = refuseRefresh(target.ref, stillTarget);
if (stillRefused || stillTarget.id !== target.id) {
  console.log(`\nREFUSING AT THE SWAP (${stillRefused?.code ?? 'target moved'}) — the target changed while generating.`);
  console.log(`Nothing moved. ${target.ref} is intact; staging tenant ${fresh.groupId} is orphaned and purgeable by id.`);
  await prisma.$disconnect();
  process.exit(2);
}

// ── 4. THE SWAP — ONE TRANSACTION, THREE RELEASE/TAKE PAIRS ───────────────────────────────────
// WHY THE ORDERING IS SAFE, AND NOT A RACE. Every one of these columns is `@unique` and both rows
// exist at this moment, so the new row cannot take a value the old row still holds. Postgres checks
// a NON-DEFERRABLE unique constraint at STATEMENT completion, not at commit — so within one
// transaction, "old releases" then "new takes" is legal: by the time the take runs, the value is
// free. It is not a window anything else can slip into either, because the two statements are in
// the same transaction and the constraint is never violated at any statement boundary.
//
// Rolling back is the whole point of the single transaction: a failure between any two of these six
// leaves the old tenant holding its own identity, rather than half of it.
const supersededRef = `${target.ref}-superseded-${epoch}`;
const supersededEmail = `demo+superseded-${epoch}@greasedesk.com`;
console.log('\n— swapping identity —');
await prisma.$transaction(async (tx) => {
  await tx.group.update({ where: { id: target.id }, data: { ref: supersededRef } });          // release
  await tx.group.update({ where: { id: fresh.groupId }, data: { ref: target.ref } });          // take
  await tx.group.update({ where: { id: target.id }, data: { billing_email: supersededEmail } });
  await tx.group.update({ where: { id: fresh.groupId }, data: { billing_email: DEMO_OWNER } });
  await tx.user.updateMany({ where: { group_id: target.id, email: DEMO_OWNER }, data: { email: supersededEmail } });
  await tx.user.updateMany({ where: { id: owner.id }, data: { email: DEMO_OWNER } });
});
console.log(`  ${target.ref} now belongs to ${fresh.groupId}`);

// ── 5. DESTROY, LAST ──────────────────────────────────────────────────────────────────────────
// If this fails the live tenant is already correct; what survives is a husk holding tombstoned
// identity, purgeable by id. That is the right way round.
console.log('\n— purging the superseded tenant —');
try {
  await purgeTenant('demo-refresh', target.id);
  console.log(`  purged the old group ${target.id}`);
} catch (e) {
  console.log(`  PURGE FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
  console.log(`  The NEW tenant is live and correct. The old row survives as ${supersededRef} — purge it by id.`);
}

const finalGroup = await prisma.group.findUnique({ where: { id: fresh.groupId }, select: { ref: true, group_name: true, billing_email: true, is_internal: true, is_demo: true } });
console.log(`\nDONE. ${finalGroup.ref}  "${finalGroup.group_name}"  is_demo=${finalGroup.is_demo} is_internal=${finalGroup.is_internal}`);
console.log(`owner login: ${finalGroup.billing_email}`);
// NO LIST EDIT. DEMO_TENANTS is keyed by `ref`, and the swap above carried the ref onto the new
// group — so the entry that authorised this run still names the tenant that came out of it. The id
// changed, as it must, and nothing depends on it.
console.log(`\ngroup id is now ${fresh.groupId} (changed, as it always does — nothing to edit: DEMO_TENANTS is keyed by ref).`);
await prisma.$disconnect();
process.exit(0);
