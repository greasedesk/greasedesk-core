/**
 * File: scripts/backfill-reporting-anchor.mjs
 *
 * PUT EVERY TENANT'S REPORTING ANCHOR BACK ON THE 1st, through the one rule that defines it.
 *
 *   node scripts/backfill-reporting-anchor.mjs --target=gate                  # DRY RUN
 *   node scripts/backfill-reporting-anchor.mjs --target=production            # DRY RUN
 *   node scripts/backfill-reporting-anchor.mjs --target=production --write     # the write
 *
 * ── WHAT THIS IS FIXING, AND WHY A SCRIPT RATHER THAN THE MIGRATION ─────────────────────────────
 * 20260830120000 backfilled existing tenants through date_trunc('month', …) and left new ones on
 * DEFAULT CURRENT_TIMESTAMP, so the column's canonical day held for every tenant alive on 30 August
 * 2026 and for none created afterwards. 20261105120000 fixes the default; this fixes the rows the
 * old default already wrote.
 *
 * It is not in that migration on purpose. An UPDATE inside a migration classifies constraining and
 * is right to — but more than that, these are live rows on real tenants, and a data fix that runs
 * itself as a side effect of a schema change is a data fix nobody saw happen. So it is a dry run by
 * default, it prints every row it would touch with before and after, and the write needs a terminal
 * and a typed confirmation. The same shape demo-shift-dates uses, for the same reason.
 *
 * ── ONE RULE, NOT A SECOND NORMALISER ───────────────────────────────────────────────────────────
 * The new value comes from lib/reporting-anchor::normaliseAnchor — the function pages/api/company
 * already uses for the one product write path. Not date_trunc in SQL, which would be a second
 * spelling of the rule that could drift from the first; not a local `new Date(y, m, 1)`, which is
 * the same mistake with fewer characters. If the rule is ever wrong it should be wrong in one place.
 *
 * It follows that this script cannot compute the UTC/local question for itself: normaliseAnchor is
 * Date.UTC(...) and so this is UTC, whatever a reader's machine is set to.
 *
 * ── NO MARKER, AND NONE NEEDED ──────────────────────────────────────────────────────────────────
 * demo-shift-dates needs a has-this-run guard because a second run shifts everything twice.
 * normaliseAnchor is IDEMPOTENT — the 1st of a month normalises to itself — so a second run finds
 * nothing to do and says so. The data's own shape is the guard, which is the cheapest kind.
 */
import './_ts.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ROOT = '/Users/hugh/Developer/greasedesk-core';
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const target = (argv.find((a) => a.startsWith('--target=')) ?? '').split('=')[1];

// THE TARGET IS NAMED, NEVER INFERRED. Without it the script does nothing: "it picked up whatever
// .env happened to say" is how a gate fixture fix lands on production.
if (target !== 'production' && target !== 'gate') {
  console.error('\n  Name the database: --target=production or --target=gate.');
  console.error('  Dry run is the default; add --write to commit. NOTHING HAS BEEN READ.\n');
  process.exit(2);
}

if (target === 'production') {
  // Production URLs have one home — the file migrate-apply and demo-shift-dates both read.
  const f = `${ROOT}/.migrate-target.production`;
  if (!existsSync(f)) { console.error(`\n  --target=production needs ${f}. NOTHING HAS BEEN READ.\n`); process.exit(2); }
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} else {
  const { config } = await import(`${ROOT}/node_modules/dotenv/lib/main.js`);
  config({ path: `${ROOT}/.env`, quiet: true });
}

const { PrismaClient } = await import(`${ROOT}/node_modules/@prisma/client/index.js`);
const prisma = new PrismaClient();
const { normaliseAnchor } = await import('../lib/reporting-anchor.ts');

const die = async (msg, code = 2) => { console.error(`\n  ${msg}\n`); await prisma.$disconnect(); process.exit(code); };

// ── WHERE ARE WE, AND IS IT WHAT WAS ASKED FOR ──────────────────────────────────────────────────
// The marker, not the URL. A hostname can be copied into the wrong file; the Environment row is
// written by whoever set the database up and is the only thing on it that says what it IS.
const endpoint = new URL(process.env.DATABASE_URL).host.split('.')[0];
const env = await prisma.environment.findFirst({ select: { kind: true, label: true } });
const EXPECT = target === 'production' ? 'production' : 'test';
console.log(`\n  endpoint      ${endpoint}`);
console.log(`  Environment   ${env?.kind ?? '(none)'}${env?.label ? ` (${env.label})` : ''}`);
if (env?.kind !== EXPECT) {
  await die(`REFUSED: --target=${target} expects an Environment marked "${EXPECT}", this one says "${env?.kind}".\n`
    + '  NOTHING HAS BEEN WRITTEN.');
}
console.log(`  rule          lib/reporting-anchor::normaliseAnchor — first of the month, UTC`);
console.log(`  mode          ${WRITE ? 'WRITE' : 'DRY RUN (reads only)'}`);

const iso = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 23) : '—');
const onCanonicalDay = (d) =>
  d.getUTCDate() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0
  && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

const groups = await prisma.group.findMany({
  select: { id: true, ref: true, group_name: true, is_demo: true, is_internal: true,
            created_at: true, reporting_start_date: true },
  orderBy: { created_at: 'asc' },
});

/**
 * WHY `==created_at` IS PRINTED, when the fix does not depend on it.
 *
 * It is the fingerprint of the old default: DEFAULT CURRENT_TIMESTAMP stored the signup instant, so
 * a row written by it has anchor == created_at to the millisecond. A row that is off the 1st WITHOUT
 * that equality was put there by something else, and that something else is not fixed by this
 * script or by the migration. Printing it means a surprise shows up as a surprise instead of being
 * silently normalised along with the rest.
 */
const rows = groups.map((g) => {
  const now = g.reporting_start_date;
  const next = normaliseAnchor(now);
  return {
    g, now, next,
    changes: next.getTime() !== now.getTime(),
    clean: onCanonicalDay(now),
    fingerprint: Math.abs(now.getTime() - g.created_at.getTime()) < 1000,
  };
});

console.log('\n' + '='.repeat(118));
console.log('ref         name                 created_at               anchor now              would become            ==created');
console.log('='.repeat(118));
for (const r of rows) {
  console.log(`${(r.g.ref ?? '—').padEnd(11)} ${String(r.g.group_name).slice(0, 20).padEnd(20)} `
    + `${iso(r.g.created_at).slice(0, 19).padEnd(23)} ${iso(r.now).slice(0, 23).padEnd(23)} `
    + `${r.changes ? iso(r.next).slice(0, 19).padEnd(23) : '(unchanged)'.padEnd(23)} ${r.fingerprint}`);
}
console.log('='.repeat(118));

const toFix = rows.filter((r) => r.changes);
const oddballs = rows.filter((r) => !r.clean && !r.fingerprint);
console.log(`  ${groups.length} tenants · ${rows.filter((r) => r.clean).length} already on the 1st at 00:00 · ${toFix.length} would change`);
console.log(`  carrying the old default's fingerprint (anchor == created_at): ${rows.filter((r) => r.fingerprint).length}`);
if (oddballs.length) {
  console.log(`\n  ⚠ ${oddballs.length} off the canonical day WITHOUT that fingerprint — not written by the old default,`);
  console.log(`    so neither the migration nor this script addresses whatever did write them:`);
  for (const r of oddballs) console.log(`      ${r.g.ref}  anchor ${iso(r.now)}  created ${iso(r.g.created_at)}`);
}

// Every new value must itself satisfy the invariant the gate asserts. Checked here rather than
// trusted, because "the normaliser normalises" is the one claim a caller of it cannot verify by
// reading its name. See scripts/reporting-anchor-gate for the same clause over stored rows.
const badTarget = toFix.filter((r) => !onCanonicalDay(r.next));
if (badTarget.length) {
  await die(`REFUSED: normaliseAnchor produced ${badTarget.length} value(s) that are NOT the 1st at 00:00:\n  `
    + badTarget.map((r) => `${r.g.ref} -> ${iso(r.next)}`).join('\n  ')
    + '\n  The rule and the invariant disagree. NOTHING HAS BEEN WRITTEN.');
}
// The same month must survive. A fix that moved a tenant's reporting into a different month would
// change what its dashboard reports, which is a different change from the one authorised.
const monthMoved = toFix.filter((r) =>
  r.next.getUTCFullYear() !== r.now.getUTCFullYear() || r.next.getUTCMonth() !== r.now.getUTCMonth());
if (monthMoved.length) {
  await die(`REFUSED: ${monthMoved.length} row(s) would land in a DIFFERENT month:\n  `
    + monthMoved.map((r) => `${r.g.ref} ${iso(r.now)} -> ${iso(r.next)}`).join('\n  ')
    + '\n  NOTHING HAS BEEN WRITTEN.');
}
console.log(`  ✓ every proposed value is the 1st at 00:00, and stays in its own month`);

if (!toFix.length) {
  console.log('\n  Nothing to do — every anchor is already on the 1st at 00:00.\n');
  await prisma.$disconnect();
  process.exit(0);
}

if (!WRITE) {
  console.log('\n  DRY RUN — nothing was written. Add --write to commit.\n');
  await prisma.$disconnect();
  process.exit(0);
}

// ── THE WRITE ───────────────────────────────────────────────────────────────────────────────────
// Spending real rows belongs to a person at a keyboard, as demo-shift-dates and encrypt-rep-bank
// both insist. The dry run above needed neither a terminal nor a confirmation.
if (!process.stdin.isTTY) await die('REFUSED: --write needs a terminal. Run it yourself; the dry run does not need one.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
console.log(`\n  This rewrites ${toFix.length} anchor(s) on ${target.toUpperCase()} (${endpoint}).`);
const typed = await ask(`  Type the target to confirm (${target}): `);
rl.close();
if (typed.trim() !== target) await die('Not confirmed. NOTHING HAS BEEN WRITTEN.', 1);

// One transaction. Not for atomicity between unrelated tenants, but so a failure half way leaves a
// database in the state the dry run described rather than a third state nobody has looked at.
await prisma.$transaction(async (tx) => {
  for (const r of toFix) {
    await tx.group.update({ where: { id: r.g.id }, data: { reporting_start_date: r.next } });
  }
});

// READ IT BACK. An update that reported success and a row that holds the new value are two claims,
// and only the second is the one that matters.
let verified = 0;
for (const r of toFix) {
  const back = await prisma.group.findUnique({ where: { id: r.g.id }, select: { reporting_start_date: true } });
  const ok = back?.reporting_start_date?.getTime() === r.next.getTime();
  console.log(`    ${ok ? '✓' : '✗'} ${r.g.ref} now ${iso(back?.reporting_start_date)}`);
  if (ok) verified += 1;
}
console.log(`\n  ${verified} of ${toFix.length} verified by reading the row back.\n`);
await prisma.$disconnect();
process.exit(verified === toFix.length ? 0 : 1);
