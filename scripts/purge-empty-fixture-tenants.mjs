/**
 * File: scripts/purge-empty-fixture-tenants.mjs
 * PURGE TWO ABANDONED GATE FIXTURES — the record of what ran, kept because it ran against
 * production data and because a purge is irreversible.
 *
 * ── WHAT THESE ARE ──────────────────────────────────────────────────────────────────────────────
 *   GB-GD2176  "New garage"  owner zz-neg-country@zzgategarage.test   created 2026-07-30
 *   GB-GD2177  "New garage"  owner zz-picker@zzgategarage.test        created 2026-07-30
 *
 * Both are residue from gates since renamed or deleted: no script or gate in the tree contains
 * either address, so they cannot be recreated. Neither is referenced anywhere — not by ref, not by
 * id, and not by any row: zero attributions, commissions, notifications, audit logs, payments,
 * billing rows, features, catalogue entries, sites or bookings. One user each, and a `tenant.viewed`
 * SuperAdminAudit row from somebody looking at the list and wondering what they were.
 *
 * ── ADDRESSED BY ID, NEVER BY NAME ──────────────────────────────────────────────────────────────
 * BOTH ARE CALLED "New garage". A purge that resolved by name could not tell them apart, and the
 * one it hit would be whichever the database returned first. The ids below are the subject; the ref
 * and the name are printed only so a person can SEE which tenant each id is before it goes.
 *
 * ── IT REFUSES ANYTHING IT DOES NOT RECOGNISE ───────────────────────────────────────────────────
 * The id must resolve, the ref and name must match what is written here, and the tenant must hold
 * NOTHING — no sites, cards, customers, vehicles, invoices, costs or bookings, and exactly one user
 * whose address is the expected fixture account. Any surprise refuses that tenant and moves on
 * rather than deleting something that has changed since this was written.
 *
 * ── THE AUDIT IS purgeTenant'S OWN ──────────────────────────────────────────────────────────────
 * It writes the SuperAdminAudit row itself, with before/after row counts, the R2 result and the
 * Stripe outcome, AFTER the transaction commits. No row is written here — a second one would be a
 * second account of the same act.
 *
 * NOTE ON R2: deleteByPrefix is a no-op when R2 is not configured, and it is not configured on this
 * machine. Harmless for these two — they have no objects — but a purge of a tenant WITH photos must
 * be run somewhere holding R2 credentials, or the objects outlive the tenant while the audit row
 * records zero.
 *
 *   node scripts/purge-empty-fixture-tenants.mjs            (dry run)
 *   node scripts/purge-empty-fixture-tenants.mjs --commit
 */
import './_gate-preflight.mjs';
const { gatePrisma } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { purgeTenant } = await import('../lib/tenant-purge.ts');
const prisma = await gatePrisma();

/** hugh@greasedesk.com — the only active owner-role operator, and the acting one. */
const OPERATOR_ID = 'acab39ee-aea8-4ae8-b855-312007bebdb2';

const SUBJECTS = [
  { id: '360af973-e3aa-442b-8bfa-0b4fa541feb0', ref: 'GB-GD2176', name: 'New garage', owner: 'zz-neg-country@zzgategarage.test' },
  { id: 'a2d31a1a-a9fd-49e4-a549-ed26572c1312', ref: 'GB-GD2177', name: 'New garage', owner: 'zz-picker@zzgategarage.test' },
];

const dry = !process.argv.includes('--commit');
console.log(dry ? '— DRY RUN. Pass --commit to purge. —\n' : '— PURGING —\n');

let failed = false;
for (const s of SUBJECTS) {
  // BY ID. The ref and name below are checked against the row, not used to find it.
  const g = await prisma.group.findUnique({
    where: { id: s.id },
    select: { id: true, ref: true, group_name: true, created_at: true, is_demo: true, is_internal: true, free_since: true },
  });
  console.log(`${s.ref}  id=${s.id}`);
  console.log(`   https://er.greasedesk.com/superadmin/tenants/${s.id}`);
  if (!g) { console.log('   NOT FOUND — already gone, nothing done\n'); continue; }
  console.log(`   name="${g.group_name}"  ref=${g.ref}  created ${g.created_at.toISOString().slice(0, 10)}`);

  if (g.ref !== s.ref || g.group_name !== s.name) {
    console.log(`   REFUSING: expected ref ${s.ref} name "${s.name}", found ref ${g.ref} name "${g.group_name}"\n`);
    failed = true; continue;
  }
  if (g.is_demo || g.is_internal || g.free_since) {
    console.log(`   REFUSING: carries a flag (demo=${g.is_demo} internal=${g.is_internal} free=${!!g.free_since}) — not the empty fixture this expects\n`);
    failed = true; continue;
  }

  const [sites, users, cards, customers, vehicles, invoices, costs, bookings] = await Promise.all([
    prisma.site.count({ where: { group_id: g.id } }),
    prisma.user.findMany({ where: { group_id: g.id }, select: { email: true } }),
    prisma.jobCard.count({ where: { group_id: g.id } }),
    prisma.customer.count({ where: { group_id: g.id } }),
    prisma.vehicle.count({ where: { group_id: g.id } }),
    prisma.invoice.count({ where: { group_id: g.id } }),
    prisma.cost.count({ where: { group_id: g.id } }),
    prisma.booking.count({ where: { group_id: g.id } }),
  ]);
  console.log(`   sites=${sites} users=${users.length} cards=${cards} customers=${customers} vehicles=${vehicles} invoices=${invoices} costs=${costs} bookings=${bookings}`);
  console.log(`   user: ${users.map((u) => u.email).join(', ') || '(none)'}`);

  const holdings = sites + cards + customers + vehicles + invoices + costs + bookings;
  if (holdings !== 0) {
    console.log(`   REFUSING: holds ${holdings} row(s) of real work — this script is only for empty fixtures\n`);
    failed = true; continue;
  }
  if (users.length !== 1 || users[0].email !== s.owner) {
    console.log(`   REFUSING: expected exactly one user "${s.owner}", found ${JSON.stringify(users.map((u) => u.email))}\n`);
    failed = true; continue;
  }
  if (dry) { console.log('   would purge — every check passed\n'); continue; }

  const r = await purgeTenant(OPERATOR_ID, g.id);
  console.log(`   PURGED. audit ${r.auditId}`);
  console.log(`   stripe=${JSON.stringify(r.stripe)}  r2Deleted=${r.r2.deleted}`);
  const remaining = Object.entries(r.after).filter(([, v]) => typeof v === 'number' && v > 0);
  console.log(`   rows remaining after: ${remaining.length ? JSON.stringify(Object.fromEntries(remaining)) : 'none'}`);
  console.log(`   group still present: ${(await prisma.group.count({ where: { id: s.id } })) > 0}\n`);
}

await prisma.$disconnect();
process.exit(failed ? 1 : 0);
