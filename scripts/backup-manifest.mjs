/**
 * File: scripts/backup-manifest.mjs
 * WHAT THE DATABASE CONTAINED AT DUMP TIME — written beside the dump, and the thing the restored copy
 * must reproduce (scripts/_backup-compare).
 *
 *   node scripts/backup-manifest.mjs <out.json>     reads DATABASE_URL
 *
 * READ-ONLY. Counts every table in the public schema — not a chosen few, because the table nobody
 * thought to list is the one a dump quietly drops — plus the June golden and the applied-migration
 * count. No tenant data is written into it: table names, row counts, and a hash.
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'node:fs';
import { juneGolden } from './_june-golden.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/backup-manifest.mjs <out.json>'); process.exit(2); }

const prisma = new PrismaClient();
try {
  // ── WHICH DATABASE IS THIS? Printed BEFORE any model query. ───────────────────────────────
  // A connection string that reaches the WRONG database used to surface as Prisma's
  //   P2021  The table `public.Invoice` does not exist in the current database.
  // thrown by a model query four calls in. That message says what is missing and never which
  // database was asked, and the host cannot be logged because it is half the credential. These
  // three can: a database name, a resolved search_path and a table count disclose nothing, and
  // they are the difference between "something is missing" and "you are in the wrong place".
  const [where] = await prisma.$queryRaw`
    SELECT current_database() AS db, array_to_string(current_schemas(false), ',') AS search_path`;
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  console.log(`source: database "${where.db}", search_path "${where.search_path}", ${tables.length} table(s) in schema public`);

  // AND REFUSE BY NAME, rather than letting a model query do it less clearly a moment later. The
  // refusal names the wrong conclusion the old failure invited: not "a table is missing" but "this
  // is a real, reachable database that is not GreaseDesk's".
  if (!tables.some((t) => t.tablename === 'Invoice')) {
    throw new Error(
      `WRONG DATABASE: "${where.db}" holds ${tables.length} table(s) in schema public and no "Invoice" `
      + `among them (search_path "${where.search_path}"). The connection works — the credentials and the `
      + `host are fine — so this is the wrong Neon BRANCH or the wrong database name, not a -pooler `
      + `problem. .env's DIRECT_URL is the string proved against the live data.`,
    );
  }

  const counts = {};
  for (const { tablename } of tables) {
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "public"."${tablename.replace(/"/g, '""')}"`);
    counts[tablename] = n;
  }
  const [{ n: migrations }] = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
  const manifest = {
    takenAt: new Date().toISOString(),
    tables: counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
    migrations,
    juneGolden: await juneGolden(prisma),
  };
  writeFileSync(out, `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`manifest: ${Object.keys(counts).length} tables, ${manifest.totalRows} rows, ${migrations} migrations, June ${manifest.juneGolden.invoices} invoices ${manifest.juneGolden.sha256.slice(0, 8)}`);
} finally {
  await prisma.$disconnect();
}
