/**
 * File: lib/demo-tenants.ts
 * THE REGISTRY of sales-demo tenants — a LIST, deliberately, and the refusal that guards them.
 *
 * ── WHY A LIST AND NOT A CONSTANT ───────────────────────────────────────────────────────────────
 * There is one demo tenant today and one rep. The obvious shape is `const DEMO_GROUP_ID = '…'`, and
 * it is the thing that makes a per-rep estate expensive later: every refresh button, every gate
 * exclusion and every "is this the demo?" check written against a single id has to be found and
 * changed. A list costs nothing today and makes the second tenant an append rather than a rewrite.
 *
 * ── AND WHY THE REFRESH REFUSES RATHER THAN TRUSTS ──────────────────────────────────────────────
 * Regeneration DESTROYS a tenant's transactional rows. The same discipline the demo lifecycle gate
 * uses applies: the target is DECLARED here, and the tool refuses anything not on the list —
 * it does not take a group id from a caller and believe it.
 *
 * Two independent conditions, both required, so neither alone can authorise a wipe:
 *   1. the id is on this list, AND
 *   2. the tenant is still `is_internal` in the database.
 *
 * (2) is not redundant. A list entry is a claim written once; `is_internal` is the fact that makes
 * the claim true, and it is checked at the moment of use. If a real customer tenant ever inherited
 * a listed id — a restored snapshot, a mis-typed migration — the list alone would authorise
 * destroying it. Same shape as the reference demo's exclusion being conditional on the facts that
 * justify it rather than on its id alone.
 */

export type DemoTenant = {
  /** Group id. */
  id: string;
  /** Human ref, for messages — never used for lookup (groups legitimately share names). */
  ref: string;
  /** Why this tenant exists, so a stale entry can be recognised as stale. */
  purpose: string;
};

/**
 * The sales-demo tenants. APPEND to add one; do not replace.
 *
 * NOT Marketbridge (`GB-GD2236`). That is the frozen reference demo, it is `is_demo = true`, it
 * cannot send SMS, and it is under a standing hold. It must never appear here — a refresh pointed
 * at it would destroy the recording set.
 */
export const DEMO_TENANTS: readonly DemoTenant[] = [
  { id: 'f3542807-2729-4bc3-8158-9bf7b9d0b353', ref: 'GB-GD2369', purpose: 'Shared sales demo — reps get their own User rows here.' },
];

export const isListedDemoTenant = (groupId: string): boolean =>
  DEMO_TENANTS.some((t) => t.id === groupId);

export type RefreshRefusal = { code: string; message: string };

/**
 * May this tenant be regenerated? PURE, so a gate can prove every refusal without destroying
 * anything — the standing rule that a destructive guard is proven against the predicate and never
 * against a real purge path.
 *
 * `group` is what the database says NOW, not what the caller claims.
 */
export function refuseRefresh(
  groupId: string,
  group: { id: string; ref: string | null; is_internal: boolean | null; is_demo: boolean } | null,
): RefreshRefusal | null {
  if (!isListedDemoTenant(groupId)) {
    return {
      code: 'not_listed',
      message: `${groupId} is not a declared demo tenant. Refresh destroys a tenant's records, so the `
        + `target must be listed in lib/demo-tenants::DEMO_TENANTS — it is never taken from the caller.`,
    };
  }
  if (!group) {
    return { code: 'not_found', message: `${groupId} is listed as a demo tenant but does not exist. Remove the stale entry.` };
  }
  // THE SECOND CONDITION, checked against the database at the moment of use. A list entry is a
  // claim; this is the fact that makes it true.
  if (group.is_internal !== true) {
    return {
      code: 'not_internal',
      message: `${group.ref ?? groupId} is listed as a demo tenant but is NOT is_internal. Something has `
        + `changed since it was listed. Refusing to destroy its records — check the tenant before the list.`,
    };
  }
  return null;
}
