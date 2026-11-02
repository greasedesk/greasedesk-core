/**
 * File: scripts/_shift-sql.mjs
 *
 * THE SQL FOR MOVING A DATE COLUMN, and the reason it is sometimes two statements.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────────────────────────
 * It was inline in demo-shift-dates.mjs, where the only thing that could check it was running the
 * shift on production. It failed there, with
 *
 *   23505  CostInstance (cost_id, period_start) = (b334c453-…, 2025-10-01) already exists
 *
 * and the transaction rolled back. Extracted so a proof can run the EXACT statements the real shift
 * runs against a fixture built to collide, instead of a second copy of the same idea written beside
 * the test — which would have agreed with itself and passed.
 *
 * ── THE COLLISION ───────────────────────────────────────────────────────────────────────────────
 * A uniform shift maps a unique set to a unique set, so one UPDATE looks obviously safe. The
 * failure is not in the before state or the after state, it is DURING the statement: Postgres
 * checks a unique index as each row is written, an UPDATE has no row order, and monthly periods
 * are each other's targets. The row moving 2025-08-01 → 2025-10-01 is checked while the row still
 * sitting on 2025-10-01 has not been moved yet.
 *
 * Deferring is not available: these are unique INDEXES (Prisma's `@@unique`), not deferrable
 * constraints, so `SET CONSTRAINTS ALL DEFERRED` has nothing to act on.
 *
 * ── THE PARKING CENTURY ─────────────────────────────────────────────────────────────────────────
 * So an affected column moves in two passes inside one transaction: every row out to a parking
 * century carrying its final offset, then every row back. Pass one cannot collide because no live
 * value sits 500 years away. Pass two cannot collide because by then every row of that column is
 * parked, and subtracting a constant is injective. The final value is identical to the one-pass
 * result; only the route differs.
 *
 * The caller must check that the parking range is actually clear of live data rather than trusting
 * that 500 years is "obviously enough" — `parkClearSql` below asks the database.
 */

/** How far out of the way rows go between the two passes. */
export const PARK = "INTERVAL '500 years'";

/** `date` columns must be cast back, or `date + interval` silently becomes a timestamp. */
const castFor = (cast) => (e) => (cast === 'date' ? `(${e})::date` : e);

/**
 * The UPDATE(s) for one column, in the order they must run.
 *
 * @param table     unquoted table name
 * @param col       unquoted column name
 * @param scopeSql  the WHERE fragment tying rows to one tenant, using $1 for the tenant id
 * @param iv        the shift, as a SQL interval literal
 * @param cast      'date' for a `date` column, anything else for a timestamp
 * @param twoPass   whether a unique index covers this column — DERIVED from pg_index, never listed
 * @returns [{ phase, sql }] — all phase-1 statements across all columns must run before any phase-2
 */
export function shiftStatements({ table, col, scopeSql, iv, cast, twoPass }) {
  const c = castFor(cast);
  const where = `WHERE ${scopeSql} AND "${col}" IS NOT NULL`;
  if (!twoPass) {
    return [{ phase: 1, sql: `UPDATE "${table}" SET "${col}" = ${c(`"${col}" + ${iv}`)} ${where}` }];
  }
  return [
    { phase: 1, sql: `UPDATE "${table}" SET "${col}" = ${c(`"${col}" + ${PARK} + ${iv}`)} ${where}` },
    { phase: 2, sql: `UPDATE "${table}" SET "${col}" = ${c(`"${col}" - ${PARK}`)} ${where}` },
  ];
}

/**
 * Which columns of these tables are covered by a unique index — asked of the database.
 *
 * A hand-written list would have been right the day it was written. CostInstance is the one that
 * fired on production; the same query finds CostRate, LeaveRecord and VehicleOdometerReading behind
 * it, and the next `@@unique` added to a dated column would be a fifth nobody remembered.
 *
 * Partial indexes are included deliberately: a `WHERE` clause narrows which rows are checked, not
 * whether the check happens, so a covered column still needs the two passes.
 */
export async function uniqueCoveredColumns(prisma, tables) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT t.relname AS table_name, pg_get_indexdef(ix.indexrelid) AS def
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND ix.indisunique AND NOT ix.indisprimary
       AND t.relname = ANY($1::text[])`, tables);
  const covered = new Set();
  for (const r of rows) {
    // The column list is the parenthesised group before any WHERE/INCLUDE tail.
    const m = r.def.match(/USING \w+ \(([^)]*)\)/);
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const col = raw.trim().replace(/"/g, '').split(/\s+/)[0];
      covered.add(`${r.table_name}.${col}`);
    }
  }
  return covered;
}

/** Does the parking range clear every live value in this column? Asked, not assumed. */
export function parkClearSql(table, col, scopeSql, iv) {
  return `SELECT min("${col}" + ${PARK} + ${iv}) AS parked_min,
                 max("${col}") AS live_max,
                 count("${col}")::int AS n
            FROM "${table}" WHERE ${scopeSql}`;
}
