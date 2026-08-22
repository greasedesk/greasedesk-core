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
  /**
   * THE IDENTITY, and the only one. Was the group id, which went stale on every refresh: a refresh
   * REPLACES the tenant rather than emptying it, so the id changes and this list stopped matching
   * the moment the operation it authorises succeeded. That cost two hand-edits per refresh — the
   * list had to point at the LIVE tenant before a run could start and at the NEW one after it
   * finished, with the second id unknowable until 27 minutes of generation had passed. Forget
   * either and the tool refuses its own target.
   *
   * `ref` is precisely what a refresh PRESERVES: it is @unique, sequence-allocated, and the swap
   * carries it from the old row to the new one. Keying on it makes the list survive the operation.
   *
   * The counter-argument, stated because it is real: an id cannot be renamed and a ref can. But
   * nothing in the product writes `ref` — the sequence default assigns it and demo-refresh moves
   * it — and being listed is only ever HALF the authority. `is_internal`, read from the database
   * at the moment of use, is the other half and is unaffected by this.
   */
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
  { ref: 'GB-GD2369', purpose: 'Shared sales demo — reps get their own User rows here.' },
];

/**
 * Callers pass the group's OWN ref, read from the database — every one of them already holds a
 * freshly-read group row, so this needs no query of its own. Passing a ref a human typed would
 * check a different question; the point is what the row says now.
 */
export const isListedDemoTenant = (ref: string | null | undefined): boolean =>
  !!ref && DEMO_TENANTS.some((t) => t.ref === ref);

export type RefreshRefusal = { code: string; message: string };

/**
 * May this tenant be regenerated? PURE, so a gate can prove every refusal without destroying
 * anything — the standing rule that a destructive guard is proven against the predicate and never
 * against a real purge path.
 *
 * `group` is what the database says NOW, not what the caller claims.
 */
export function refuseRefresh(
  /** The ref the operator named. Compared against the LIST; the row below is the second condition. */
  ref: string,
  group: { id: string; ref: string | null; is_internal: boolean | null; is_demo: boolean } | null,
): RefreshRefusal | null {
  if (!isListedDemoTenant(ref)) {
    return {
      code: 'not_listed',
      message: `${ref} is not a declared demo tenant. Refresh destroys a tenant's records, so the `
        + `target must be listed in lib/demo-tenants::DEMO_TENANTS — it is never taken from the caller.`,
    };
  }
  // REACHABLE NOW, AND IT WAS NOT BEFORE. Keyed by id, a caller with no group row had nothing to
  // pass but the ref, which never matched an id — so a listed-but-missing tenant reported
  // `not_listed` and this branch could not be reached. Keyed by ref the two are told apart.
  if (!group) {
    return { code: 'not_found', message: `${ref} is listed as a demo tenant but does not exist. Remove the stale entry.` };
  }
  // THE SECOND CONDITION, checked against the database at the moment of use. A list entry is a
  // claim; this is the fact that makes it true.
  if (group.is_internal !== true) {
    return {
      code: 'not_internal',
      message: `${group.ref ?? ref} is listed as a demo tenant but is NOT is_internal. Something has `
        + `changed since it was listed. Refusing to destroy its records — check the tenant before the list.`,
    };
  }
  return null;
}

/**
 * MAY A MAINTENANCE SCRIPT WRITE TO THIS DEMO TENANT?
 *
 * Distinct from `refuseRefresh` on purpose. That one authorises DESTRUCTION and its message says so.
 * This authorises a repair — a ledger backfill, a column fill — on a tenant whose data is invented.
 * The two conditions are the same because the targeting discipline is the same: a list entry is a
 * claim written once, `is_internal` is the fact that makes it true, checked at the moment of use.
 *
 * The FROZEN REFERENCE is excluded by construction, not by a name check: Marketbridge is
 * deliberately absent from DEMO_TENANTS, so "listed" already means "not the frozen one". A second,
 * explicit exclusion by id would be a rule that could drift out of step with the list it duplicates.
 *
 * WHY THIS EXISTS AT ALL: scripts/payment-backfill refused every `is_demo` tenant outright, on the
 * reasoning that nothing in a demo is real. True, and it is exactly why a demo needs the repair —
 * its 743 paid invoices had no Payment rows, so the dashboard a prospect sees first read £0.00
 * revenue. "Not real" is an argument about what the data MEANS, not about whether it should be
 * self-consistent.
 */
export function refuseDemoMaintenance(
  groupId: string,
  group: { ref: string | null; is_internal: boolean | null; is_demo: boolean } | null,
): RefreshRefusal | null {
  if (!isListedDemoTenant(groupId)) {
    return {
      code: 'not_listed',
      message: `${groupId} is a demo tenant but is not declared in lib/demo-tenants::DEMO_TENANTS. `
        + `Maintenance scripts write only to declared demos — which excludes the frozen reference demo, `
        + `deliberately absent from that list.`,
    };
  }
  if (!group) return { code: 'not_found', message: `${groupId} is listed as a demo tenant but does not exist.` };
  if (group.is_internal !== true) {
    return {
      code: 'not_internal',
      message: `${group.ref ?? groupId} is listed but is NOT is_internal. Something has changed since it `
        + `was listed — check the tenant before the list.`,
    };
  }
  return null;
}
