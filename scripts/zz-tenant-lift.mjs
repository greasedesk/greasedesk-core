/**
 * File: scripts/zz-tenant-lift.mjs
 *
 * GIVE THE GATE TENANT A LIFT. One permanent Resource on ZZ Gate Garage, on the gate database.
 *
 * NOT NAMED 'gate-…', and that is not cosmetic: scripts/gates.mjs discovers its gates with
 * /gate|timing/ over the filename, so 'gate-tenant-lift.mjs' was collected as a GATE and the whole
 * runner refused to start until it was tiered. Tiering it would have been the wrong answer twice —
 * it asserts nothing, and it is write-capable, so every gate run would have executed it.
 *
 *   node scripts/zz-tenant-lift.mjs             # DRY RUN
 *   node scripts/zz-tenant-lift.mjs --write     # the write
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Measured 2026-11-07: ZERO Resources on the entire gate database. A booking is
 * `resource_id + start_at + end_at` (lib/jobcard-status::isBookedCard), so with no lift anywhere,
 * no gate can build a BOOKED card — and `no_show` is gated on `booking_exists`. All five
 * no-show-gate failures trace to one line: the fixture dies on `resource_id`, `start_at` falls back
 * to `created_at`, and the missed-slot date comes out as today.
 *
 * A gate that cannot construct its subject does not go red for a real reason; it goes red for want
 * of a row. Worse, the clauses downstream of the crash never run at all, so the tally said "5 of
 * 33" about a suite that had stopped before it reached most of its own questions.
 *
 * ── PERMANENT, NOT THROWAWAY, AND THAT IS THE DECISION ──────────────────────────────────────────
 * Every other fixture in no-show-gate is created and removed in a finally block, which is right for
 * rows that encode a scenario. A LIFT is not a scenario — it is part of what the tenant IS. A
 * garage with no lift does not resemble any tenant this product has, so a gate database without one
 * is not a quiet gap, it is a tenant that cannot be booked.
 *
 * Three further reasons it should not be per-run:
 *   · every diary, booking, occupancy and hold gate needs one, so throwaway means N copies of the
 *     same setup and N chances for one of them to differ;
 *   · pages/api/resources.ts deletes a Resource with NO audit row (boarded), so churning them is
 *     the one operation on this table that leaves no trace;
 *   · a Resource cascades from Site, so it survives exactly as long as the tenant does.
 *
 * ── IDEMPOTENT, SO A REBUILT GATE DATABASE CAN JUST RUN IT ──────────────────────────────────────
 * The guard is the data's own shape: a lift already on the site means there is nothing to do, and
 * the script says so rather than adding a second. No marker to read, nothing to keep in step.
 *
 * NO AUDIT ROW, deliberately. AuditLog.action is a closed union and this is tenant SETUP on a test
 * database, not an act by a garage user — inventing an action for it would put a fixture concern
 * into the trail every real tenant shares.
 */
import './_ts.mjs';

const ROOT = '/Users/hugh/Developer/greasedesk-core';
const WRITE = process.argv.includes('--write');

const { config } = await import(`${ROOT}/node_modules/dotenv/lib/main.js`);
config({ path: `${ROOT}/.env`, quiet: true });

const { PrismaClient } = await import(`${ROOT}/node_modules/@prisma/client/index.js`);
const prisma = new PrismaClient();
const die = async (m, c = 2) => { console.error(`\n  ${m}\n`); await prisma.$disconnect(); process.exit(c); };

// ZZ Gate Garage. Hard-coded and then cross-checked, the same shape demo-shift-dates uses: an id
// alone could be a tenant that has since been replaced.
const ZZ_ID = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const ZZ_REF = 'GB-GD2141';
const LIFT = { name: 'ZZ Lift 1', type: 'lift', display_order: 1, colour: null, is_active: true };

const endpoint = new URL(process.env.DATABASE_URL).host.split('.')[0];
const env = await prisma.environment.findFirst({ select: { kind: true, label: true } });
console.log(`\n  endpoint      ${endpoint}`);
console.log(`  Environment   ${env?.kind ?? '(none)'}${env?.label ? ` (${env.label})` : ''}`);

// THE GATE DATABASE, AND ONLY IT. A production tenant's lifts are a garage's own operational data;
// this script must never be the thing that invents one.
if (env?.kind !== 'test') {
  await die(`REFUSED: this writes a fixture and only belongs on the gate database (Environment "test").\n`
    + `  This one says "${env?.kind}". NOTHING HAS BEEN WRITTEN.`);
}

const g = await prisma.group.findUnique({
  where: { id: ZZ_ID },
  select: { id: true, ref: true, group_name: true, is_internal: true },
});
if (!g) await die(`REFUSED: no group ${ZZ_ID} on this database.`);
if (g.ref !== ZZ_REF) await die(`REFUSED: ${ZZ_ID} has ref "${g.ref}", expected "${ZZ_REF}" — the tenant may have been replaced.`);
console.log(`  tenant        ${g.ref} ${g.group_name} (is_internal ${g.is_internal})`);

const sites = await prisma.site.findMany({
  where: { group_id: g.id },
  select: { id: true, site_name: true, open_hour: true, close_hour: true, open_days: true },
  orderBy: { site_name: 'asc' },
});
if (sites.length !== 1) {
  await die(`REFUSED: expected exactly one site on ${ZZ_REF}, found ${sites.length}:\n  `
    + sites.map((s) => `${s.site_name} (${s.id})`).join('\n  ')
    + '\n  Which site the lift belongs to is a decision, not a guess.');
}
const site = sites[0];
console.log(`  site          ${site.site_name}  ${site.open_hour}-${site.close_hour}  days ${JSON.stringify(site.open_days)}`);

const existing = await prisma.resource.findMany({
  where: { site_id: site.id },
  select: { id: true, name: true, type: true, is_active: true, display_order: true },
});
const anywhere = await prisma.resource.count();
console.log(`  lifts on this site   ${existing.length}`);
console.log(`  Resources anywhere   ${anywhere}`);

console.log('\n' + '='.repeat(74));
if (existing.length) {
  console.log('  NOTHING TO DO — this site already has a bookable resource:');
  for (const r of existing) console.log(`    ${r.name}  type=${r.type}  order=${r.display_order}  is_active=${r.is_active}  id=${r.id}`);
  console.log('='.repeat(74) + '\n');
  await prisma.$disconnect();
  process.exit(0);
}
console.log('  WOULD CREATE one Resource:');
console.log(`    site_id        ${site.id}   (${site.site_name})`);
for (const [k, v] of Object.entries(LIFT)) console.log(`    ${k.padEnd(14)} ${v === null ? 'null' : String(v)}`);
console.log('='.repeat(74));

if (!WRITE) {
  console.log('\n  DRY RUN — nothing was written. Add --write to create it.\n');
  await prisma.$disconnect();
  process.exit(0);
}

/**
 * ── NO TERMINAL, NO TYPED CONFIRMATION, AND THAT IS NOT AN OVERSIGHT ───────────────────────────
 * demo-shift-dates and backfill-reporting-anchor both demand a TTY and the target typed back,
 * because they spend REAL ROWS on a database a garage depends on. Copying that ceremony here would
 * be the shape without the reason: this script refuses every database whose Environment marker is
 * not "test", and every gate in the suite writes to that same database unattended, hundreds of
 * rows a run, with no terminal anywhere.
 *
 * The guard that matters is the one above — the marker, which is a fact about the DATABASE rather
 * than about who is typing. A confirmation prompt on top of it would only mean the write cannot be
 * made by the thing that needs to make it, and a guard whose premise does not apply is how the
 * useful ones get removed along with it.
 */

const made = await prisma.resource.create({ data: { site_id: site.id, ...LIFT }, select: { id: true } });

// READ IT BACK. "create resolved" and "the row is there, bookable, on the right site" are two
// claims and only the second is the one the gates depend on.
const back = await prisma.resource.findUnique({
  where: { id: made.id },
  select: { id: true, site_id: true, name: true, type: true, display_order: true, colour: true, is_active: true },
});
const ok = back && back.site_id === site.id && back.name === LIFT.name && back.type === LIFT.type && back.is_active === true;
console.log(`\n  ${ok ? '✓' : '✗'} created and read back: ${JSON.stringify(back)}`);
console.log(`  Resources anywhere on this database now: ${await prisma.resource.count()}\n`);
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
