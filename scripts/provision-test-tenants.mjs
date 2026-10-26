/**
 * File: scripts/provision-test-tenants.mjs
 * (NOT named *-gate*: the runner picks gates up by that substring in the filename and refused to
 * start, reporting this tool as "a gate in no tier". One label, two subjects.)
 * THE STANDING TENANTS THE GATE SUITE NEEDS, created from nothing.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * 117 gates reference ZZ Gate Garage and 18 of them name it directly through zzSite. Until
 * 2026-10-26 that tenant existed only because somebody made it by hand on the production database
 * a year ago, and nothing recorded how. The first run of the suite against the new gate database
 * returned 64 reds, almost all of them one sentence: "ZZ Gate Garage has no owner — the tenant
 * this gate needs is not set up."
 *
 * So the gate environment is reproducible now. That is worth having quite apart from the second
 * database: an environment that cannot be rebuilt is one nobody dares change.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────────────────────
 * It will not run against production, and it checks that TWICE — the Environment marker must read
 * `test`, and the endpoint must not hash to production's. Either alone would be a single point of
 * failure for a script whose job is creating tenants: on production it would start making garages
 * on the live system.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────────────────────────
 * Every write is an upsert on a pinned id or a unique ref. Running it twice changes nothing, which
 * is what lets it be the first thing anybody does to a fresh database without thinking about it.
 *
 * ── THE IDENTITIES ARE MEASURED, NOT INVENTED ──────────────────────────────────────────────────
 * The first version made up `zz-owner@greasedesk.test` with a password of its own. The suite does
 * not care what this script thinks: 83 gates hardcode `owner@zzgategarage.test`, one hardcodes
 * `manager@zzgategarage.test`, and 65 type `GateGarage!2026`. Those strings ARE the contract, and
 * inventing different ones produced a tenant no gate could sign into.
 *
 * `gate@zzgategarage.test` appears too but only ever as a notification RECIPIENT, never a login,
 * so it needs no User row.
 *
 * ── THE PASSWORD IS IN THE FILE, DELIBERATELY ──────────────────────────────────────────────────
 * Same choice the gates already make, and the same string they already contain 65 times — this
 * discloses nothing new. It is a login to a tenant that exists only on a throwaway database
 * holding no customer data, and the alternative — a secret the suite needs and nobody can find —
 * is how a reproducible environment stops being one. It must never be given to a tenant on
 * production, which is what the two refusals above enforce.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { describeTarget } = await import('./_db-target.mjs');
const bcrypt = (await import('bcryptjs')).default;

const ZZ_GROUP = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const ZZ_REF = 'GB-GD2141';
const ZZUS_REF = 'US-GD2175';
const FIXTURE_PASSWORD = 'GateGarage!2026';   // what 65 gates already type
const ZZ_OWNER = 'owner@zzgategarage.test';   // what 83 gates already sign in as
const ZZ_MANAGER = 'manager@zzgategarage.test';
const ZZUS_OWNER = 'owner@zzusmotors.test';   // no gate signs in here yet; symmetry only
/** Users the FIRST version of this script invented. Removed so ZZ has one owner, not two. */
const WRONG_FROM_FIRST_DRAFT = ['zz-owner@greasedesk.test', 'zzus-owner@greasedesk.test'];

const say = (s = '') => console.log(s);
let prisma;

try {
  // ── BOTH REFUSALS, BEFORE ANYTHING IS CREATED ───────────────────────────────────────────────
  const target = describeTarget();
  if (!target.safe) {
    say(`REFUSING: the endpoint is not positively known to be non-production`);
    say(`  runtime ${target.runtime} ${target.runtimeEndpoint ?? '—'} · migrations ${target.migrations} ${target.migrationsEndpoint ?? '—'}`);
    process.exit(2);
  }
  prisma = await gatePrisma();
  const env = await prisma.environment.findUnique({ where: { id: 'singleton' }, select: { kind: true, label: true } });
  if (env?.kind !== 'test') {
    say(`REFUSING: the Environment marker reads ${env?.kind ?? 'MISSING'}, not test.`);
    say('  A database that has not declared itself a test environment is treated as production.');
    process.exit(2);
  }
  say(`Target: ${env.label ?? target.runtimeEndpoint} (marker: test, endpoint: ${target.runtimeEndpoint})\n`);

  /** A tenant, its canonical site, and an owner who points at that site — what zzSite requires. */
  const tenant = async ({ id, ref, name, country, email, internal }) => {
    const group = await prisma.group.upsert({
      where: { id },
      update: { group_name: name, country_code: country, tax_country_code: country, is_internal: internal },
      create: { id, group_name: name, billing_email: email, country_code: country, tax_country_code: country, is_internal: internal },
      select: { id: true, ref: true },
    });
    // REF IS SEQUENCE-GENERATED (`START WITH 1965`) and the gates pin exact strings — US-GD2175 is
    // named in fourteen places. A fresh database's sequence cannot reproduce them by chance, so it
    // is set explicitly. Raw SQL rather than Prisma: the column is @default(dbgenerated()), and
    // whether the client accepts a value for one of those is a detail to not depend on.
    if (group.ref !== ref) {
      await prisma.$executeRawUnsafe('UPDATE "Group" SET ref = $1 WHERE id = $2', ref, id);
    }
    const existingSite = await prisma.site.findFirst({ where: { group_id: id }, orderBy: { created_at: 'asc' }, select: { id: true } });
    const site = existingSite ?? await prisma.site.create({
      data: { group_id: id, site_name: `${name} — main`, currency_code: country === 'US' ? 'USD' : 'GBP', locale: country === 'US' ? 'en-US' : 'en-GB' },
      select: { id: true },
    });
    const user = await prisma.user.upsert({
      where: { email },
      update: { group_id: id, is_owner: true, is_active: true, primary_site_id: site.id },
      create: {
        email, name: `${name} owner`, role: 'ADMIN', is_owner: true, is_active: true,
        group_id: id, primary_site_id: site.id, passwordHash: await bcrypt.hash(FIXTURE_PASSWORD, 10),
      },
      select: { id: true },
    });
    return { groupId: id, ref, siteId: site.id, userId: user.id };
  };

  const zz = await tenant({
    id: ZZ_GROUP, ref: ZZ_REF, name: 'ZZ Gate Garage', country: 'GB',
    email: ZZ_OWNER, internal: true,
  });
  say(`ZZ Gate Garage   group ${zz.groupId}`);
  say(`                 ref ${zz.ref} · site ${zz.siteId} · owner ${ZZ_OWNER}`);

  // ZZUS is resolved by REF, not by a pinned id — fourteen gates name US-GD2175 and none names a
  // uuid, so the ref is the identity and the id is free.
  const existingUs = await prisma.group.findFirst({ where: { ref: ZZUS_REF }, select: { id: true } });
  const us = await tenant({
    id: existingUs?.id ?? crypto.randomUUID(), ref: ZZUS_REF, name: 'ZZUS Motors', country: 'US',
    email: ZZUS_OWNER, internal: true,
  });
  say(`ZZUS Motors      group ${us.groupId}`);
  say(`                 ref ${us.ref} · site ${us.siteId} · owner ${ZZUS_OWNER}`);

  // ── THE SITE MANAGER ────────────────────────────────────────────────────────────────────────
  // support-route-gate signs in as this one to prove a site manager, not only the account holder,
  // reaches the support route. A UserSite ROW is required as well as site_id: a STANDARD fixture
  // once had the column and not the row, and canAccessSite refused it — caught by a discriminator
  // clause, which is what discriminators are for.
  const mgr = await prisma.user.upsert({
    where: { email: ZZ_MANAGER },
    update: { group_id: ZZ_GROUP, role: 'SITE_MANAGER', is_active: true, primary_site_id: zz.siteId },
    create: {
      email: ZZ_MANAGER, name: 'ZZ site manager', role: 'SITE_MANAGER', is_active: true,
      group_id: ZZ_GROUP, primary_site_id: zz.siteId, passwordHash: await bcrypt.hash(FIXTURE_PASSWORD, 10),
    },
    select: { id: true },
  });
  await prisma.userSite.upsert({
    where: { user_id_site_id: { user_id: mgr.id, site_id: zz.siteId } },
    update: {}, create: { user_id: mgr.id, site_id: zz.siteId },
  }).catch(async () => {
    const has = await prisma.userSite.findFirst({ where: { user_id: mgr.id, site_id: zz.siteId } });
    if (!has) await prisma.userSite.create({ data: { user_id: mgr.id, site_id: zz.siteId } });
  });
  say(`                 manager ${ZZ_MANAGER} (SITE_MANAGER, with a UserSite row)`);

  const removed = await prisma.user.deleteMany({ where: { email: { in: WRONG_FROM_FIRST_DRAFT } } });
  if (removed.count) say(`\nremoved ${removed.count} user(s) this script invented before the identities were measured`);

  say(`\nBoth tenants are is_internal. The password is the one 65 gates already type.`);
} catch (e) {
  say(`\nFAILED: ${describeError(e)}`);
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
