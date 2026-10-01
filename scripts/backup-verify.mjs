/**
 * File: scripts/backup-verify.mjs
 * THE RESTORE TEST. Reads the RESTORED copy (DATABASE_URL points at it), builds the same manifest the
 * source wrote, and compares. Exits non-zero, loudly, on any difference.
 *
 *   node scripts/backup-verify.mjs <source-manifest.json>
 *
 * A backup nobody has restored is a hypothesis. This is what makes the nightly job a restore test
 * rather than a file-copy with a green tick.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
import { juneGolden } from './_june-golden.mjs';
import { compareManifests } from './_backup-compare.mjs';

const sourcePath = process.argv[2];
if (!sourcePath) { console.error('usage: node scripts/backup-verify.mjs <source-manifest.json>'); process.exit(2); }
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));

const prisma = new PrismaClient();
let restored;
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
  restored = { takenAt: new Date().toISOString(), tables: counts, totalRows: Object.values(counts).reduce((a, b) => a + b, 0), migrations, juneGolden: await juneGolden(prisma) };
} finally {
  await prisma.$disconnect();
}
writeFileSync('restored-manifest.json', `${JSON.stringify(restored, null, 1)}\n`);

const { ok, problems } = compareManifests(source, restored);
console.log(`source  : ${Object.keys(source.tables ?? {}).length} tables, ${source.totalRows} rows, June ${source.juneGolden?.invoices} invoices / ${source.juneGolden?.lines} lines / £${((source.juneGolden?.grossPence ?? 0) / 100).toFixed(2)} / ${String(source.juneGolden?.sha256).slice(0, 8)}`);
console.log(`restored: ${Object.keys(restored.tables).length} tables, ${restored.totalRows} rows, June ${restored.juneGolden.invoices} invoices / ${restored.juneGolden.lines} lines / £${(restored.juneGolden.grossPence / 100).toFixed(2)} / ${restored.juneGolden.sha256.slice(0, 8)}`);
if (ok) { console.log('\nRESTORE VERIFIED — the restored copy reproduces the source exactly.'); process.exit(0); }
console.error(`\nRESTORE DID NOT VERIFY — ${problems.length} problem(s):`);
for (const p of problems) console.error(`  · ${p}`);
console.error('\nThe dump in R2 is NOT a faithful copy. Do not rely on tonight\'s backup.');
process.exit(1);
