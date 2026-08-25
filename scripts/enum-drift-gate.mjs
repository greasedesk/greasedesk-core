// @gate-timeout: 90
/**
 * File: scripts/enum-drift-gate.mjs
 * A HAND-MAINTAINED LIST AND A DATABASE ENUM, AND THE JOIN NOBODY CHECKS.
 *
 * lib/battery::CCA_STANDARDS listed six CCA standards. The Postgres enum had five. Both sides were
 * internally correct and the code compiled, because the write casts through `as never` — so tapping
 * "Not stated" in either capture form produced a PrismaClientValidationError, a 500 carrying an
 * HTML error page, and on the phone an outbox row that retried for two hours (500 is not terminal)
 * and then failed permanently. Retrying, the obvious response, could never work.
 *
 * ── WHY A GATE AND NOT A TYPE ───────────────────────────────────────────────────────────────────
 * TypeScript SHOULD catch this: assigning a six-member union to a five-member generated enum is
 * exactly the error it exists to raise. `as never` silences all of it — `never` is assignable to
 * everything — so `tsc --noEmit` passed with the defect in place. The casts at the battery writer
 * are gone now, but thirteen others remain and each one is a place the compiler has been switched
 * off. This gate is what stands in for the compiler at those points.
 *
 * ── WHAT IT REACHES, AND WHAT IT CANNOT ─────────────────────────────────────────────────────────
 * It compares a LIST to an enum. That covers every cast whose value comes from a hand-maintained
 * list — the shape that failed. It does NOT cover a cast of a single literal (`'not_raised' as
 * never`), which is a different check, and it does not cover casts in the READ direction, where a
 * database value is asserted into a TS type and the database is already the authority. Those are
 * named in the register below rather than left to look covered. See fixture-name-collision: a
 * partial check that reads as a complete one retires the vigilance covering the rest.
 *
 * A SUBSET IS DECLARED, NEVER INFERRED. pages/api/observations deliberately offers three of the
 * four DueItemResponse values. That is a real design decision and must not be silently equal to a
 * list that has drifted — so `subset` is a mode you have to write down, with a reason.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

/**
 * Pull a literal string array out of a named const. Anchored on the DECLARATION — `const NAME` and
 * its `[...]` — not on the bare identifier, which also appears at every use site.
 */
const listFromSource = (file, name) => {
  const src = readFileSync(file, 'utf8');
  const m = src.match(new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) return null; // caller fails loudly — a scan that matches nothing must never read as a pass
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

const B = await import('../lib/battery.ts');
const D = await import('../lib/duplicate-cards.ts');

const REGISTER = [
  { label: 'lib/battery::CCA_STANDARDS', enumName: 'CcaStandard', mode: 'exact',
    list: () => B.CCA_STANDARDS },
  { label: 'lib/due-items::RESPONSES', enumName: 'DueItemResponse', mode: 'exact',
    list: () => listFromSource('lib/due-items.ts', 'RESPONSES') },
  { label: 'pages/api/observations::RESPONSES', enumName: 'DueItemResponse', mode: 'subset',
    why: 'wants_call is answered elsewhere; this surface offers three of the four on purpose',
    list: () => listFromSource('pages/api/observations.ts', 'RESPONSES') },
  { label: 'pages/api/marketing-contact::STATES', enumName: 'MarketingState', mode: 'exact',
    list: () => listFromSource('pages/api/marketing-contact.ts', 'STATES') },
  // The fifth: not one of the four, but the same shape and importable, so it costs nothing to hold.
  // Built by statusSubset() — a compile-checked total map — so TS already guards its MEMBERSHIP;
  // what it cannot guard is the enum having moved underneath it.
  { label: 'lib/duplicate-cards::OPEN_FOR_DUPLICATE', enumName: 'JobCardStatus', mode: 'subset',
    why: 'the OPEN statuses only — a subset by construction',
    list: () => D.OPEN_FOR_DUPLICATE },
];

try {
  const rows = await prisma.$queryRaw`
    SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS vals
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`;
  const db = new Map(rows.map((r) => [r.name, r.vals]));
  check('the database reports its enums at all', db.size > 0, `${db.size} enums`);

  for (const e of REGISTER) {
    const vals = db.get(e.enumName);
    if (!vals) { check(`${e.label}: pg enum ${e.enumName} exists`, false, 'no such enum — the register names one that is not there'); continue; }
    const list = e.list();
    // A SCAN THAT MATCHED NOTHING IS A FAILURE, never a silent pass. The extraction regexes are the
    // weakest link here and an empty list would compare equal to everything.
    if (!list || list.length === 0) { check(`${e.label}: the list was found`, false, 'extraction returned nothing — the declaration moved or was renamed'); continue; }

    const extra = list.filter((x) => !vals.includes(x));
    check(`${e.label} → ${e.enumName}: every value exists in the database`, extra.length === 0,
      extra.length ? `IN TS NOT DB: ${extra.join(', ')} — a write of these throws PrismaClientValidationError, no code, 500` : `${list.length} values`);

    const missing = vals.filter((x) => !list.includes(x));
    if (e.mode === 'exact') {
      check(`  …and covers the enum completely`, missing.length === 0,
        missing.length ? `in db not ts: ${missing.join(', ')} — a value nothing can produce` : 'exact match');
    } else {
      check(`  …declared SUBSET, and still a subset`, true, `${e.why} (omits ${missing.join(', ') || 'nothing'})`);
    }
  }

  // ── THE CASTS THIS GATE DOES NOT REACH, COUNTED SO THE NUMBER CANNOT DRIFT SILENTLY ──────────
  // @scan-ok: counting a cast token across source files is the measurement, not a proxy for one.
  const files = ['lib/battery.ts', 'lib/credit-note.ts', 'lib/invoice-issue.ts', 'lib/marketing-board.ts',
    'pages/api/observations.ts', 'pages/api/intake-items.ts', 'pages/api/service-schedule.ts',
    'pages/api/due-items.ts', 'pages/api/marketing-contact.ts', 'pages/api/vehicle-lookup.ts'];
  const casts = files.reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(/\bas never\b/g)].length, 0);
  check('the battery writer no longer casts its enum away', !/cca_standard: [^,]*as never/.test(readFileSync('lib/battery.ts', 'utf8')),
    'the compiler is back on at the point that failed');
  console.log(`\n  ${casts} \`as never\` casts remain in these ten files — this gate reaches the ${REGISTER.length} LIST-shaped ones.`);
  console.log('  The rest are single literals or read-direction asserts and need a different check.');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 700)}`);
  out.push('F');
} finally {
  await prisma.$disconnect();
}
const f = out.filter((x) => x === 'F').length;
console.log(`\n${f} failures of ${out.length}`);
process.exit(f ? 1 : 0);
