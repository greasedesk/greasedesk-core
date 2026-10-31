/**
 * File: scripts/entitlement-snapshot.mjs
 * WHAT EVERY TENANT IS ENTITLED TO RIGHT NOW — counted, read-only, before and after a deploy.
 *
 * ── WHY A SNAPSHOT AND NOT AN ARGUMENT ─────────────────────────────────────────────────────────
 * Entitlement moved from the Stripe PRICE to the Stripe PRODUCT on 2026-10-28. The claim is that
 * no existing subscriber is affected, and the gate proves that over a recorded subscription. This
 * is the other half: the same count taken on PRODUCTION before the deploy and again after, which
 * is the only evidence about the garages that actually exist.
 *
 * It counts rows BY SOURCE and BY KEY. A total alone would hide the failure mode that matters —
 * a `stripe` row flipping from enabled to disabled while a `grant` row flips the other way nets
 * to zero and is two tenants with the wrong access.
 *
 * SELECTs only. No transaction, no write, no model method that could make one.
 *
 *     DATABASE_URL='<production>' node scripts/entitlement-snapshot.mjs > before.txt
 *     node scripts/entitlement-snapshot.mjs --diff before.txt after.txt
 *
 * ── WHY THE COMPARISON IS A MODE AND NOT A `diff` ──────────────────────────────────────────────
 * The snapshot stamps the time it was taken, so a plain `diff` of two files can never print
 * IDENTICAL — the one line that is SUPPOSED to differ guarantees it. During the 2026-10-30 deploy
 * that produced a report reading "the only difference is the taken: line", which is a human
 * filtering a known-irrelevant difference by eye, every time, for ever. The knowledge of which
 * line does not count belongs in the tool.
 */

/** The one line that is meant to differ between two snapshots. */
const STAMP_PREFIX = 'taken:  ';

/**
 * COMPARE TWO SNAPSHOTS, ignoring the stamp and nothing else. Every other line must match exactly:
 * this is evidence about real tenants, so "close enough" is not a verdict it is allowed to reach.
 */
if (process.argv[2] === '--diff') {
  const { readFileSync } = await import('node:fs');
  const [, , , beforePath, afterPath] = process.argv;
  if (!beforePath || !afterPath) {
    console.error('usage: node scripts/entitlement-snapshot.mjs --diff <before.txt> <after.txt>');
    process.exit(2);
  }
  const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith(STAMP_PREFIX));
  const a = lines(beforePath);
  const b = lines(afterPath);
  const stamps = [beforePath, afterPath].map((f) =>
    (readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith(STAMP_PREFIX)) ?? '(no stamp)').trim());
  console.log(`before: ${stamps[0]}`);
  console.log(`after:  ${stamps[1]}`);
  // NAMED, so a report cannot say "identical" about two files that were never compared: if one
  // side is empty the snapshot did not run, and two empty files are not an agreement.
  if (a.length === 0 || b.length === 0) {
    console.error(`REFUSING A VERDICT — ${a.length === 0 ? beforePath : afterPath} has no snapshot lines at all.`);
    process.exit(2);
  }
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) diffs.push(`  line ${i + 1}\n    before: ${a[i] ?? '(absent)'}\n    after:  ${b[i] ?? '(absent)'}`);
  }
  if (diffs.length === 0) {
    console.log(`IDENTICAL — ${a.length} lines compared, the stamp ignored.`);
    process.exit(0);
  }
  console.log(`${diffs.length} DIFFERENCE(S) of ${Math.max(a.length, b.length)} lines compared:`);
  console.log(diffs.join('\n'));
  process.exit(1);
}
import { classifyUrl } from './_db-target.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL. Run it with the production connection string:\n'
    + "    DATABASE_URL='<production>' node scripts/entitlement-snapshot.mjs");
  process.exit(2);
}
const target = classifyUrl(url);
console.log(`target: ${target}${target === 'production' ? '' : '  ← NOT production; this snapshot is of some other database'}`);
console.log(`${STAMP_PREFIX}${new Date().toISOString()}`);

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  const rows = await prisma.$queryRaw`
    SELECT feature_key, source, enabled, count(*)::int AS n
      FROM "GroupFeature"
     GROUP BY feature_key, source, enabled
     ORDER BY feature_key, source, enabled
  `;
  const subs = await prisma.$queryRaw`
    SELECT COALESCE(subscription_status, '(none)') AS status, count(*)::int AS n
      FROM "GroupBilling"
     GROUP BY 1 ORDER BY 1
  `;
  const groups = await prisma.group.count();

  console.log(`\n${groups} group(s).`);
  console.log('\nGroupFeature rows — key / source / enabled / count:');
  if (rows.length === 0) {
    // AN EMPTY POPULATION IS A RESULT, AND A DIFFERENT ONE. No rows means every tenant is on
    // MODULE_DEFAULT_WHEN_UNSET, so the deploy cannot move anybody — but "0 rows unchanged" is
    // weaker evidence than "41 rows unchanged", and the reader must be told which they have.
    console.log('  (none) — every tenant is on the unset default, so there is nothing here to move.');
  } else {
    for (const r of rows) console.log(`  ${r.feature_key.padEnd(10)} ${String(r.source).padEnd(8)} ${r.enabled ? 'on ' : 'off'}  ${r.n}`);
  }
  console.log('\nGroupBilling subscription_status:');
  for (const r of subs) console.log(`  ${String(r.status).padEnd(20)} ${r.n}`);
  console.log('\nRun this again AFTER the deploy. Every line above must be identical.');
} catch (e) {
  console.error(`\nFAILED to read: ${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
