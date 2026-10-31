/**
 * File: scripts/tenant-population-gate.mjs
 * @gate-requires: db, server
 *
 * WHICH TENANTS ARE CUSTOMERS — and that every reader asks the same way.
 *
 * ── WHAT HAPPENED, TWICE ────────────────────────────────────────────────────────────────────────
 * `Group.is_internal` is NULLABLE and NULL means nobody has said. Postgres puts NULL outside BOTH
 * obvious spellings, so both silently drop every tenant whose flag was never set:
 *
 *     { is_internal: false }         → "is_internal" = $1   → misses NULL
 *     { is_internal: { not: true } } → "is_internal" <> $1  → misses NULL
 *
 * The first shape was caught while writing the operator-alert sweep, which would have alerted on
 * nothing. The second shipped, and the Engine Room dashboard read **"Tenants in scope: 0"** with
 * every garage on the platform a paying customer. Nothing drove that screen, so nothing noticed.
 *
 * ── WHY AN INDEPENDENT ORACLE AND NOT A SECOND CALL TO THE PREDICATE ────────────────────────────
 * Checking `NOT_OURS` by running `NOT_OURS` agrees with itself. The expected number here comes from
 * RAW SQL written by hand, so the Prisma predicate and the oracle reach the same answer by different
 * routes. And the screen is driven for real, because the defect was never in the predicate — it was
 * in what one page passed to it.
 *
 * ── AND IT REFUSES TO RUN ON A POPULATION THAT CANNOT EXPOSE THE BUG ────────────────────────────
 * If no Group has `is_internal` NULL, the broken and correct spellings return the same number and
 * every clause below passes while testing nothing. That is declined, not reported green.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, erOrigin, ER_RESOLVER_ARGS, serverReady, declineToRun } = await import('./_gate-preflight.mjs');
const { readFileSync, readdirSync } = await import('node:fs');
const { underPath } = await import('../lib/anchored-match.ts');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const OP_EMAIL = 'zzgate-population-owner@greasedesk.test';
const OP_PASS = 'GatePopulation!2026';

let prisma; let browser = null;
try {
  const P = await import(`${R}/lib/tenant-population.ts`);
  const ER = erOrigin();
  await serverReady(ER);
  prisma = await gatePrisma();

  // ── THE ORACLE, in hand-written SQL ──────────────────────────────────────────────────────────
  const [census] = await prisma.$queryRaw`
    SELECT
      count(*) FILTER (WHERE is_internal IS NULL)  AS nulls,
      count(*) FILTER (WHERE is_internal IS TRUE)  AS trues,
      count(*) FILTER (WHERE is_internal IS FALSE) AS falses
    FROM "Group"`;
  const nulls = Number(census.nulls), trues = Number(census.trues), falses = Number(census.falses);
  const customers = nulls + falses;
  console.log(`— population: ${nulls} NULL · ${trues} true · ${falses} false —`);

  if (nulls === 0) {
    declineToRun(
      'No Group has is_internal NULL on this database, so `<> true` and the correct predicate return ' +
      'the same number and every clause here would pass without testing anything. Plant a tenant with ' +
      'is_internal NULL — which is what a real signup writes — and run again.');
  }

  // ── THE PREDICATE, against the oracle ────────────────────────────────────────────────────────
  console.log('\n— THE PREDICATE —');
  const viaPredicate = await prisma.group.count({ where: P.NOT_OURS });
  check('NOT_OURS counts every tenant that is not explicitly ours',
    viaPredicate === customers, `predicate ${viaPredicate} vs hand-written SQL ${customers}`);
  const viaOurs = await prisma.group.count({ where: P.OURS });
  check('  …and OURS claims only the explicit trues, never an unset flag',
    viaOurs === trues, `OURS ${viaOurs} vs SQL ${trues}`);
  check('  …and the two partition the table, with nothing counted twice or dropped',
    viaPredicate + viaOurs === nulls + trues + falses,
    `${viaPredicate} + ${viaOurs} = ${viaPredicate + viaOurs} of ${nulls + trues + falses}`);

  // THE BROKEN SPELLINGS, driven so the difference is a measurement and not a memory.
  const brokenNotTrue = await prisma.group.count({ where: { is_internal: { not: true } } });
  const brokenFalse = await prisma.group.count({ where: { is_internal: false } });
  check('`{ not: true }` really does drop the NULLs — this is the shipped bug, reproduced',
    brokenNotTrue === falses && brokenNotTrue !== customers,
    `{ not: true } = ${brokenNotTrue}, correct = ${customers}, difference = ${customers - brokenNotTrue} tenant(s)`);
  check('  …and so does `: false`, the other way the same mistake is written',
    brokenFalse === falses && brokenFalse !== customers, `: false = ${brokenFalse}`);

  // ── NO THIRD VERSION. A sweep, so the next caller cannot invent its own spelling. ────────────
  console.log('\n— ONE SPELLING, EVERYWHERE —');
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(`${R}/${dir}`, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!/node_modules|\.next/.test(rel)) walk(rel); }
      else if (/\.tsx?$/.test(e.name)) files.push(rel);
    }
  };
  walk('lib'); walk('pages'); walk('components');
  const offenders = [];
  for (const f of files) {
    if (f.endsWith('lib/tenant-population.ts')) continue; // the definition itself, and the gate below reads it
    const src = readFileSync(`${R}/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    // NARROWED TO THE HAZARD, which is the two spellings that silently EXCLUDE NULL.
    // `is_internal: true` is deliberately not flagged: as a filter it means exactly "ours" and is
    // correct, and as a VALUE it is how an internal tenant gets created (lib/demo/generate,
    // lib/demo-tenant, lib/onboarding all write it). The first version of this clause flagged those
    // writes and went red on correct code — a rule that cannot tell a filter from a value is a rule
    // that gets waived.
    // @anchored-ok: matching a Prisma FILTER expression on one named column, not a JS object key lookup
    for (const m of src.matchAll(/is_internal\s*:\s*(false|\{\s*not\s*:)/g)) {
      offenders.push(`${f} → is_internal: ${m[1]}`);
    }
  }
  check('nothing outside lib/tenant-population spells the is_internal filter itself',
    offenders.length === 0, offenders.length ? offenders.join('; ').slice(0, 200) : 'every caller imports the predicate');

  // ── AND THE SCREEN THAT GOT IT WRONG ─────────────────────────────────────────────────────────
  console.log('\n— THE TILE THAT READ ZERO —');
  const bcrypt = await import('bcryptjs');
  await prisma.operator.deleteMany({ where: { email: OP_EMAIL } });
  await prisma.operator.create({ data: {
    email: OP_EMAIL, name: 'Tenant population gate', role: 'owner', status: 'active',
    regions: ['GB'], passwordHash: await bcrypt.default.hash(OP_PASS, 10) } });

  browser = await chromium.launch({ channel: 'chrome', args: ER_RESOLVER_ARGS });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1200 } })).newPage();
  const onLogin = (pathname) => underPath(pathname, '/superadmin/login');
  await page.goto(`${ER}/superadmin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', OP_EMAIL);
  await page.fill('input[type="password"]', OP_PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !onLogin(u.pathname), { timeout: 60000 }).catch(() => {});
  check('an owner operator is signed in', !onLogin(new URL(page.url()).pathname), page.url());

  await page.goto(`${ER}/superadmin/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="er-tenant-count"]', { timeout: 30000 }).catch(() => {});
  const shown = (await page.textContent('[data-testid="er-tenant-count"]').catch(() => null))?.trim() ?? '(absent)';
  check('the dashboard tile shows the number of CUSTOMER tenants',
    shown === String(customers), `tile "${shown}" vs ${customers} customers (the bug showed ${brokenNotTrue})`);
  check('  …and that is not the number the broken spelling would have shown',
    shown !== String(brokenNotTrue), `broken spelling would show ${brokenNotTrue}`);
  const box = await page.locator('[data-testid="er-tenant-count"]').boundingBox().catch(() => null);
  check('  …painted, not merely present', !!box && box.width > 5 && box.height > 10,
    box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'NO BOX');

  /**
   * THE PLACEHOLDER THAT OUTLIVED ITS PREMISE. "Arrives when billing goes live" was still on this
   * screen with billing live on live keys and paying tenants, which reads as a broken feature
   * rather than an unbuilt one. Removed rather than computed: nothing in this database records a
   * collected payment (StripeEvent is a dedupe ledger; CommissionEntry.amount_pennies is the rep's
   * share, and only for attributed tenants), so any figure would under-report while looking exact.
   */
  const body = (await page.textContent('body')) ?? '';
  check('no tile claims revenue "arrives when billing goes live" — billing IS live',
    !/Arrives when billing goes live/i.test(body));
  check('  …and no revenue figure is invented from a database that does not record payments',
    !/Total revenue/i.test(body), (body.match(/Total revenue[^£]*£?[\d,.]*/) ?? ['none'])[0].slice(0, 60));

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    await prisma.operator.deleteMany({ where: { email: OP_EMAIL } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
