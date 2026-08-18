/**
 * File: scripts/demo-subject.mjs
 * Point the demo's ONE real phone number at a customer. Dry by default.
 *
 *   node scripts/demo-subject.mjs --group=GB-GD2369 > /tmp/s.log 2>&1
 *   node scripts/demo-subject.mjs --group=GB-GD2369 --apply > /tmp/s.log 2>&1
 *
 * The number lives HERE, in the operator-facing script, not in lib/demo/profile.ts — the extractor
 * rewrites that file wholesale and would delete it.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { isListedDemoTenant } = await import('../lib/demo-tenants.ts');
const { refuseDemoSubject, demoSubjectColumns } = await import('../lib/demo/demo-subject.ts');

/** Owner-supplied, real, and the only reachable number in the whole tenant. */
const SUBJECT = { name: 'Hugh Gunn', phone: '07397387332' };

const ref = process.argv.find((a) => a.startsWith('--group='))?.split('=')[1];
const APPLY = process.argv.includes('--apply');
if (!ref) { console.log('Usage: --group=<ref> [--apply]'); process.exit(2); }

const g = await prisma.group.findFirst({ where: { ref }, select: { id: true, ref: true, group_name: true, is_internal: true } });
const refusal = refuseDemoSubject(g?.id ?? ref, isListedDemoTenant(g?.id ?? ''), g, SUBJECT);
if (refusal) { console.log(`REFUSING (${refusal.code})\n\n  ${refusal.message}`); await prisma.$disconnect(); process.exit(2); }

// The customer with the MOST RECENT job card: the demo needs a subject that already has something
// to send about, not an empty record the rep has to build up on the spot.
const recent = await prisma.jobCard.findFirst({
  where: { group_id: g.id, customer_id: { not: null } },
  orderBy: { created_at: 'desc' },
  select: { customer: { select: { id: true, name: true, phone: true, phone_e164: true } } },
});
if (!recent?.customer) { console.log('No customer with a job card on this tenant.'); await prisma.$disconnect(); process.exit(2); }

const cols = demoSubjectColumns(SUBJECT);
console.log(`${g.ref} ${g.group_name}`);
console.log(`  subject customer: ${recent.customer.name}  ${recent.customer.phone} / ${recent.customer.phone_e164}`);
console.log(`  would become:     ${cols.name}  ${cols.phone} / ${cols.phone_e164}`);

const others = await prisma.customer.count({ where: { group_id: g.id, phone_e164: { not: { startsWith: '447700900' } } } });
console.log(`  customers NOT on the drama range before this: ${others}`);

if (!APPLY) { console.log('\nDry run. Re-run with --apply.'); await prisma.$disconnect(); process.exit(0); }
await prisma.customer.update({ where: { id: recent.customer.id }, data: cols });
const after = await prisma.customer.findUnique({ where: { id: recent.customer.id }, select: { name: true, phone: true, phone_e164: true } });
console.log(`\n  APPLIED: ${after.name}  ${after.phone} / ${after.phone_e164}`);
const off = await prisma.customer.findMany({ where: { group_id: g.id, phone_e164: { not: { startsWith: '447700900' } } }, select: { name: true, phone_e164: true } });
console.log(`  reachable customers on this tenant: ${off.length} — ${off.map((c) => `${c.name} ${c.phone_e164}`).join(', ')}`);
await prisma.$disconnect();
