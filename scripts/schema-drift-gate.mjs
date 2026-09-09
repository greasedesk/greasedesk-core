/**
 * File: scripts/schema-drift-gate.mjs
 * THE SCHEMA AND THE DATABASE AGREE — CHECKED, NOT REMEMBERED.
 * @gate-requires: db
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * `prisma migrate dev` proposes a RESET against this database, so every migration here is written
 * by hand and applied with `migrate deploy`. That works, and it puts the whole burden of "did the
 * SQL you wrote actually match the schema you edited?" on somebody remembering to run
 * `migrate diff` afterwards. It has been on the open list as standing debt since the schema-drift
 * ruling, with the note that a hand-run check is one distracted evening from not happening.
 *
 * Nothing caught drift in between. enum-drift-gate compares pg_enum against the TypeScript unions —
 * a different question entirely, and blind to a column, an index or a constraint that exists in one
 * place and not the other.
 *
 * ── WHAT DRIFT ACTUALLY LOOKS LIKE HERE ─────────────────────────────────────────────────────────
 * Not a dramatic mismatch. It looks like an index Prisma would name differently, a column added to
 * the SQL and forgotten in schema.prisma, or a CHECK that only the migration knows about. All of
 * them are silent until the day the client is regenerated and a query names a column that is not
 * there. The rep-portal migration produced two of the first kind within an hour of being applied.
 *
 * ── THE PREAMBLE IS NOT DRIFT ───────────────────────────────────────────────────────────────────
 * `migrate diff` ALWAYS emits `CREATE SCHEMA IF NOT EXISTS "public"`, on a perfectly clean database.
 * So "the diff is empty" is not a string comparison against '' — it is "nothing remains once the
 * constant preamble and the comments are removed". That parser is proved below on a real diff
 * before it is trusted on this one, because a stripper that removes too much is a gate that passes
 * for the wrong reason.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
const { execFileSync } = await import('node:child_process');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

/**
 * WHAT REMAINS OF A DIFF ONCE THE NOISE IS GONE. Exported so the synthetic cases below test the
 * real parser rather than a copy of it.
 *
 * Removed: Prisma's own chatter (config lines), SQL comments, blank lines, and the one constant
 * statement it emits for every diff. NOTHING ELSE — in particular no attempt to judge which DDL is
 * "harmless", because that judgement is exactly what a drift gate must not make.
 */
export function realDdl(diff) {
  return diff
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^--/.test(l))                                  // SQL comments
    .filter((l) => !/^(Loaded Prisma config|Prisma config detected|Environment variables loaded)/.test(l))
    .filter((l) => !/^CREATE SCHEMA IF NOT EXISTS "public";?$/.test(l));
}

try {
  // ── 1. THE PARSER, PROVEN ON REAL DIFF OUTPUT ────────────────────────────────────────────────
  console.log('\n— proven on real diff output —');
  const CLEAN = 'Loaded Prisma config from prisma.config.ts.\n\n-- CreateSchema\nCREATE SCHEMA IF NOT EXISTS "public";\n';
  check('a clean diff reads as clean', realDdl(CLEAN).length === 0, JSON.stringify(realDdl(CLEAN)));
  const DIRTY = CLEAN + '\n-- AlterTable\nALTER TABLE "Rep" ADD COLUMN "nickname" TEXT;\n';
  check('  …and one added column does NOT', realDdl(DIRTY).length === 1, realDdl(DIRTY).join(' | '));
  const RENAME = CLEAN + '\n-- RenameIndex\nALTER INDEX "public"."A_b_key" RENAME TO "A_c_key";\n';
  check('  …nor does a renamed index', realDdl(RENAME).length === 1,
    'the shape the rep-portal migration actually produced — twice, within an hour of applying');
  check('  …nor a dropped one', realDdl(CLEAN + '\nDROP INDEX "public"."A_b_key";\n').length === 1,
    'a drift gate must not judge which DDL is harmless — that judgement is the defect');
  check('a comment naming a table is not DDL', realDdl(CLEAN + '\n-- ALTER TABLE "Rep" ADD COLUMN "x" TEXT;\n').length === 0,
    'the migration files are full of SQL in comments explaining what was done');

  // ── 2. THE REAL ANSWER ───────────────────────────────────────────────────────────────────────
  console.log('\n— and the live database agrees with prisma/schema.prisma —');
  // BOTH DIRECTIONS FROM ONE COMMAND: schema.prisma is the "from", the live database the "to", so
  // what comes back is the SQL that would make the DATABASE match the SCHEMA. Empty means neither
  // has anything the other lacks.
  const diff = execFileSync('npx', [
    'prisma', 'migrate', 'diff',
    '--from-schema-datamodel', 'prisma/schema.prisma',
    '--to-schema-datasource', 'prisma/schema.prisma',
    '--script',
  ], { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

  const ddl = realDdl(diff);
  check('migrate diff proposes nothing', ddl.length === 0,
    ddl.length ? `${ddl.length} statement(s):\n    ${ddl.slice(0, 6).join('\n    ')}` : 'schema.prisma and the database describe the same thing');
  // NOT VACUOUS. If the command ever silently produced nothing at all — a changed flag, a failed
  // connection swallowed — every clause above would pass while proving nothing.
  check('  …and the diff really ran', /CREATE SCHEMA IF NOT EXISTS/.test(diff),
    'the constant preamble is the proof there was output to strip');

  // ── 3. AND EVERY MIGRATION IS APPLIED ────────────────────────────────────────────────────────
  // A diff can be empty while a migration sits unapplied, if the schema file was never edited for
  // it. Different question, same afternoon of confusion.
  console.log('\n— and every migration on disk has been applied —');
  let status = '';
  try {
    status = execFileSync('npx', ['prisma', 'migrate', 'status'], { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status = String(e.stdout ?? '') + String(e.stderr ?? '');   // non-zero exit IS the pending case
  }
  check('no migration is pending', /Database schema is up to date/.test(status),
    (status.match(/following migrations? have not yet been applied[\s\S]{0,200}/) ?? [])[0]?.trim()
      ?? status.trim().split('\n').slice(-2).join(' ').slice(0, 160));
} catch (e) {
  check('gate run completed', false, describeError(e));
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
