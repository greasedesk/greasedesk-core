/**
 * File: scripts/_marker-read.mjs
 * READ THE Environment MARKER AND SAY WHICH OF THREE THINGS IT IS.
 *
 * Extracted from migrate-apply so the exact code that prints before a production apply can be run
 * on its own against a database that has no Environment table. It was inline, and a --dry-run
 * exits before reaching it — so the branch was handed over having never executed once. A line
 * nobody has run is not a fix.
 *
 * `describe` is a PARAMETER rather than an import: the one thing this must never do is fail while
 * reporting a failure, and the caller already has describeError, which leads with the error CLASS
 * so an error carrying no message still names itself. A Neon compute asleep after idle throws
 * exactly that — PrismaClientInitializationError with neither code nor message — and the first
 * version of this printed `unreadable ()` at the moment somebody was deciding whether to type a
 * production endpoint id.
 */

/** 'present' | 'missing' | 'unreadable', with a sentence for a human. */
export async function readMarker(client, describe) {
  try {
    const row = await client.environment.findUnique({ where: { id: 'singleton' }, select: { kind: true, label: true } });
    if (!row) return { state: 'missing', text: 'MISSING (table exists, no row) — this migration writes it' };
    return { state: 'present', kind: row.kind, text: `${row.kind}${row.label ? ` (${row.label})` : ''}` };
  } catch (e) {
    const d = describe(e);
    // P2021 (Prisma) and 42P01 (Postgres) both mean the table is not there, which before this
    // migration runs is the EXPECTED state and not a fault. Collapsing it into "unreadable" told
    // the owner a missing table and a dead connection were the same thing.
    if (/P2021|42P01|does not exist/.test(d)) {
      return { state: 'missing', text: 'MISSING (no Environment table) — this migration creates it' };
    }
    return { state: 'unreadable', text: `unreadable — ${d.slice(0, 120)}` };
  }
}
