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
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
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
