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
    onProgress: (s, d) => console.log(`  ${s}${d ? ` — ${d}` : ''}`),
  });
  const g = await prisma.group.findUnique({ where: { id: res.groupId }, select: { ref: true, is_demo: true, is_internal: true, phone: true } });
  console.log(`\ncreated ${g.ref}  is_demo=${g.is_demo}  is_internal=${g.is_internal}  phone=${g.phone}`);
  console.log(`owner login: ${DEMO_OWNER}`);
  console.log(`\nADD THIS TO lib/demo-tenants::DEMO_TENANTS, or refresh will refuse it:\n`);
  console.log(`  { id: '${res.groupId}', ref: '${g.ref}', purpose: 'Shared sales demo — reps get their own User rows here.' },`);
  await prisma.$disconnect();
  process.exit(0);
}

const ref = arg('group');
if (!ref) { console.log('Usage: --create, or --group=<ref> [--apply]'); await prisma.$disconnect(); process.exit(2); }

// Resolve BY REF, never findFirst-by-name: groups legitimately share names.
const target = await prisma.group.findFirst({ where: { ref }, select: { id: true, ref: true, group_name: true, is_internal: true, is_demo: true } });
const refusal = refuseRefresh(target?.id ?? ref, target);
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
if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to regenerate.');
  await prisma.$disconnect();
  process.exit(0);
}
console.log('\nNOT IMPLEMENTED YET: the destroy-and-regenerate step.');
console.log('The guard, the target list and the dry run are in place; the wipe is deliberately');
console.log('left unbuilt until the tenant exists and its shape is confirmed on the iPad.');
await prisma.$disconnect();
process.exit(0);
