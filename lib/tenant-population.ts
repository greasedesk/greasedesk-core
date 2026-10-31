/**
 * File: lib/tenant-population.ts
 *
 * WHICH TENANTS ARE CUSTOMERS — as one Prisma predicate, in a LEAF module.
 *
 * ── WHY IT IS NOT WRITTEN INLINE, AND WHY NOT IN lib/operator-alerts ────────────────────────────
 * `Group.is_internal` is NULLABLE and NULL means nobody has said. Postgres puts NULL outside both
 * `= false` and `<> true`, so BOTH obvious spellings silently drop every tenant whose flag was
 * never set:
 *
 *     { is_internal: false }      → "is_internal" = $1    → misses NULL
 *     { is_internal: { not: true } } → "is_internal" <> $1 → misses NULL
 *
 * That has now happened twice. The first was a sweep that matched none of seven tenants. The second
 * was the Engine Room dashboard reading "Tenants in scope: 0" while every garage on the platform
 * was a customer — measured 2026-10-31 on the gate database: `{ not: true }` returned 0 where the
 * predicate below returned 4, against a census of 4 NULL, 2 true, 0 false.
 *
 * A LEAF, with no imports at all, because the second caller is a PAGE. `lib/operator-alerts` reaches
 * the database and the notification spine; importing a constant from it into `pages/superadmin/
 * dashboard.tsx` would drag that whole chain into the browser bundle. A shared constant has to live
 * somewhere that costs nothing to import.
 *
 * It is a `where` fragment, so it composes with `AND` beside a region scope rather than replacing it.
 *
 * NO `as const`, deliberately: it would make the inner `OR` a readonly tuple, which Prisma's
 * `GroupWhereInput` refuses, and the fix for that is never a cast — a cast here is exactly where the
 * compiler would stop checking that this predicate still matches the column.
 */

/** Tenants that are somebody's garage: `is_internal` false OR never set. NULL is a customer. */
export const NOT_OURS = { OR: [{ is_internal: null }, { is_internal: false }] };

/** The inverse: GreaseDesk's own tenants. Explicit `true` only — an unset flag is not ours to claim. */
export const OURS = { is_internal: true };
