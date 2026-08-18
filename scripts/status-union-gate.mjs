/**
 * File: scripts/status-union-gate.mjs
 * A NEW JobStatus MUST BE DECIDED EVERYWHERE, NOT DISCOVERED READER BY READER.
 *
 * Five times in one week a value was added and its readers were found by accident. The fix is in
 * two halves, and this gate is only the second:
 *
 *   COMPILE TIME (the real enforcement): every membership list is built from a
 *   Record<JobStatus, boolean> — statusSubset (OFF_DIARY, QUOTE_CLOSED, WIP) — and every
 *   per-status mapping is a Record<JobStatus, …> (PAY_STATE_BY_STATUS). Adding a status fails tsc
 *   at EVERY one of those sites until someone writes the decision. tsc runs on every push; that
 *   half costs nothing and cannot be forgotten.
 *
 *   RUNTIME (this file): the readers TypeScript cannot see — the Prisma enum, the i18n files — and
 *   the discipline that the lists actually go THROUGH statusSubset rather than reverting to bare
 *   arrays, which would silently opt back out of the compile-time check.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { JOB_STATUSES, OFF_DIARY_STATUSES, paymentState } = await import('../lib/jobcard-status.ts');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── 1. THE DATABASE ENUM AND THE TS LIST AGREE, BOTH DIRECTIONS ─────────────────────────────────
console.log('\n— Prisma enum ↔ JOB_STATUSES —');
const enumRows = await prisma.$queryRawUnsafe(
  `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'JobCardStatus' ORDER BY e.enumsortorder`);
const dbVals = enumRows.map((r) => r.enumlabel);
const missingInDb = JOB_STATUSES.filter((s) => !dbVals.includes(s));
const missingInTs = dbVals.filter((s) => !JOB_STATUSES.includes(s));
check('every TS status exists in the DATABASE enum', missingInDb.length === 0, missingInDb.join(', ') || `${dbVals.length} values`);
check('every database value exists in the TS list', missingInTs.length === 0, missingInTs.join(', ') || 'none stranded');

// ── 2. EVERY STATUS HAS ITS WORDS ───────────────────────────────────────────────────────────────
console.log('\n— i18n: a status the UI cannot name renders as a raw key —');
const jc = JSON.parse(readFileSync('public/locales/en-GB/jobcard.json', 'utf8'));
const noLabel = JOB_STATUSES.filter((s) => typeof jc.status?.[s] !== 'string' || !jc.status[s].trim());
check('en-GB has a label for every status', noLabel.length === 0, noLabel.join(', ') || `${JOB_STATUSES.length} labelled`);

// ── 3. EVERY STATUS HAS A MONEY LABEL — the runtime face of the Record ─────────────────────────
console.log('\n— paymentState never says unknown for a real status —');
const unknowns = JOB_STATUSES.filter((s) => paymentState(s) === 'unknown');
check('no real status maps to unknown', unknowns.length === 0, unknowns.join(', ') || 'all decided');
check('the check is discriminating — a fake status DOES read unknown', paymentState('not_a_status') === 'unknown');

// ── 4. THE LISTS STAY ON THE COMPILE-TIME RAIL ──────────────────────────────────────────────────
console.log('\n— membership lists go through statusSubset (bare arrays opt out of tsc) —');
for (const [file, name] of [
  ['lib/jobcard-status.ts', 'OFF_DIARY_STATUSES'],
  ['lib/quotes-list.ts', 'QUOTE_CLOSED_CARD_STATUSES'],
  ['lib/wip.ts', 'WIP_STATUSES'],
]) {
  const src = readFileSync(file, 'utf8');
  check(`${name} is statusSubset({...})`, new RegExp(`${name}(: JobStatus\\[\\])? = statusSubset\\(\\{`).test(src),
    'a bare array here would silently stop failing to compile when a status is added');
}
// And no NEW bare inline status lists in query positions — the drift that bit at tiles:374.
const tiles = readFileSync('lib/dashboard-tiles.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('dashboard-tiles has no inline status notIn list', !/notIn: \['[a-z_']+,?\s*'/.test(tiles), 'reads OFF_DIARY_STATUSES');
check('  …and OFF_DIARY_STATUSES currently carries no_show', OFF_DIARY_STATUSES.includes('no_show'));

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
