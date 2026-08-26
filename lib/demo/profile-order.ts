/**
 * File: lib/demo/profile-order.ts
 * A DETERMINISTIC ORDER FOR A MAP BUILT FROM DATABASE ROWS.
 *
 * demo-profile-gate asserts the extractor is deterministic: two runs against the same tenant must
 * produce the same file. It fired on 26 Aug 2026 with two hashes that differed while every emitted
 * VALUE was identical — because LINE_TYPE_MIX was `Object.entries(typeCount)` with no sort, and a
 * JavaScript object with non-integer string keys iterates in INSERTION order.
 *
 * `typeCount` is filled by walking invoice lines from a `findMany` with no `orderBy`, and Postgres
 * makes no ordering promise without one. Whichever line type appears FIRST in that scan becomes the
 * first key in the emitted file. Nothing about the data changed; the bytes did.
 *
 * ── WHY IT ALMOST NEVER FIRES ───────────────────────────────────────────────────────────────────
 * A sequential scan usually returns rows in stable physical order, so the first line is the same
 * line every time and the order looks fixed for months. It moves when the heap does: a bulk insert
 * and delete, a vacuum, or a plan flip. The failing run came directly after demo-generation-gate
 * had spent 1,520 seconds creating and removing a whole demo tenant, which is exactly that.
 *
 * Sorted by COUNT DESCENDING, key ascending as the tie-break — descending because the emitted file
 * is read by humans and the biggest share belongs at the top, and the tie-break because count alone
 * is not a total order and two types with equal counts would put us straight back here.
 */
export function orderedShares(
  counts: Record<string, number>,
  share: (n: number) => number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => [k, share(n)]),
  );
}
