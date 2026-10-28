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
 *     DATABASE_URL='<production>' node scripts/entitlement-snapshot.mjs
 */
import { classifyUrl } from './_db-target.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL. Run it with the production connection string:\n'
    + "    DATABASE_URL='<production>' node scripts/entitlement-snapshot.mjs");
  process.exit(2);
}
const target = classifyUrl(url);
console.log(`target: ${target}${target === 'production' ? '' : '  ← NOT production; this snapshot is of some other database'}`);
console.log(`taken:  ${new Date().toISOString()}`);

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
