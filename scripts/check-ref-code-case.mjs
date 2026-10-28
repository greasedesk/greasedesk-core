/**
 * File: scripts/check-ref-code-case.mjs
 * DO TWO REF CODES DIFFER ONLY BY CASE? Read-only, and the answer decides a ruling.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * Affiliate codes are matched case-insensitively (owner, 2026-10-28): a code is read off a card or
 * a bio link and retyped by someone who was never shown the capitals. Rep codes are NOT, yet —
 * `Rep.ref_code` is @unique and Postgres uniqueness is case-SENSITIVE, so 'ABC' and 'abc' can both
 * exist, and folding them would make one of the two unreachable and pay the other. The ruling is:
 * fold reps too IF nothing on production collides; leave them exactly as they are if anything does.
 *
 * This is the measurement that ruling waits on. It is not a gate: the question is about the
 * production data, and a gate runs against the gate database where the answer is always no.
 *
 * ── HOW TO RUN IT ───────────────────────────────────────────────────────────────────────────────
 *     DATABASE_URL='<the production connection string>' node scripts/check-ref-code-case.mjs
 *
 * It SELECTs and nothing else — no transaction, no write, no Prisma model client that could.
 * It prints which kind of database it reached (hashed comparison, see scripts/_db-target.mjs) but
 * never the host, the user or the string itself, because this repository is public.
 */
import { classifyUrl } from './_db-target.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL in the environment. Run it with the production connection string:\n'
    + "    DATABASE_URL='<production>' node scripts/check-ref-code-case.mjs");
  process.exit(2);
}

const target = classifyUrl(url);
console.log(`target: ${target}${target === 'production' ? '' : '  ← NOT production; the answer below is about some other database'}`);

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  const rows = await prisma.$queryRaw`
    SELECT lower(ref_code) AS folded,
           count(*)::int   AS n,
           array_agg(ref_code ORDER BY ref_code) AS codes,
           array_agg(party_type::text ORDER BY ref_code) AS kinds
      FROM "Rep"
     GROUP BY lower(ref_code)
    HAVING count(*) > 1
     ORDER BY 1
  `;
  const total = await prisma.rep.count();
  const reps = await prisma.rep.count({ where: { party_type: 'rep' } });

  console.log(`\n${total} partner row(s): ${reps} rep, ${total - reps} affiliate.`);
  if (rows.length === 0) {
    // A CLEAN VERDICT OVER AN EMPTY POPULATION IS STILL A POSITIVE REPORT, but it is a different
    // one, so the count above is printed whatever the answer is. "No collisions among 0 rows" and
    // "no collisions among 40 rows" are not the same evidence for folding rep matching.
    console.log('NO collisions: no two ref codes differ only by case.');
    console.log(reps === 0
      ? '  …but there are no rep rows at all, so this says nothing about reps yet.'
      : '  → the ruling permits folding rep matching too (lib/attribution::findPartyByRefCode).');
  } else {
    console.log(`${rows.length} COLLISION(S) — rep matching must stay exactly as it is:`);
    for (const r of rows) console.log(`  ${r.codes.join('  /  ')}   (${r.kinds.join(', ')})`);
  }
} catch (e) {
  console.error(`\nFAILED to read: ${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
