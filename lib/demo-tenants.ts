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
 * THE FROZEN REFERENCE DEMO. A SECOND list, and deliberately NOT an entry in DEMO_TENANTS.
 *
 * ── WHY A LIST AND NOT "ANY UNLISTED DEMO" ──────────────────────────────────────────────────────
 * Owner's ruling, 2026-11-02: the reference demo stays protected from jobs that act ON a tenant —
 * crons, sweeps, lifecycle — while an owner-run one-off script may write to it with an explicit
 * flag plus the ref typed back. That override has to POINT somewhere. Spelled as "any `is_demo`
 * tenant not in DEMO_TENANTS" it would be a pattern, and the argument at the top of this file is
 * that protection is a list you must be ON rather than a pattern you can match. Authorisation
 * deserves the same shape. Today the population is exactly one tenant, which is precisely when a
 * list and a pattern are indistinguishable and the wrong one gets chosen.
 *
 * ── WHY IT IS NOT JUST ADDED TO DEMO_TENANTS ────────────────────────────────────────────────────
 * That list authorises AUTOMATED maintenance, and being on it is what demo-refresh demands before
 * it DESTROYS a tenant. This one grants strictly less: one operator, at a keyboard, naming the
 * tenant and typing its ref. The two must never merge, so they are two lists and
 * demo-maintenance-guard-gate asserts they are disjoint — an entry on both would mean the narrower
 * authority had quietly become the wider one.
 *
 * ── AND WHY THE GATES KEEP THEIR OWN COPIES ─────────────────────────────────────────────────────
 * demo-lifecycle-gate says it in as many words: never put the declaration where the guarded thing
 * can reach it. This module is imported by the app, so it is exactly that place. The gates' own
 * hardcoded refs therefore STAY, and the gate asserts they agree with this list rather than
 * replacing them with it. Agreement catches drift; sharing would remove the second opinion.
 */
export const REFERENCE_DEMOS: readonly DemoTenant[] = [
  { ref: 'GB-GD2236', purpose: 'Frozen reference demo — the recording set, and the fixture other tenants are compared against.' },
];

export const isReferenceDemo = (ref: string | null | undefined): boolean =>
  !!ref && REFERENCE_DEMOS.some((t) => t.ref === ref);

/**
 * WHO IS ASKING — and it is a SEPARATE question from which tenant.
 *
 * `refuseDemoMaintenance` used to answer one question: is this tenant a declared demo? The ruling
 * above makes the answer depend on the CALLER as well, because a cron and a person at a keyboard
 * must get different answers about the same tenant. Folding that into the tenant question — a
 * single `allowReferenceDemo` boolean — would be one knob answering two questions, and wrong for
 * one of them the first time a cron is handed a config file.
 */
export type MaintenanceActor = 'automation' | 'operator';

export type MaintenanceRequest = {
  /**
   * DEFAULT 'automation', so a caller that does not say is treated as a cron. Every existing
   * caller keeps its behaviour with no edit, and a new script that forgets to think about this
   * gets the safe answer rather than the convenient one.
   */
  actor?: MaintenanceActor;
  /**
   * Is this call authorising a WRITE? A dry run reads and needs no typed confirmation — demanding
   * one would mean typing a ref to find out whether there is anything to do, and a ceremony people
   * perform to see a number stops being a ceremony.
   */
  write?: boolean;
  /** The reference-demo override: the flag the operator passed, and the ref they typed back. */
  override?: {
    /** `--allow-reference-demo` was on the command line. */
    flagged?: boolean;
    /** The operator typed the tenant's ref and it matched. Set by the SCRIPT, never inferred. */
    confirmed?: boolean;
  };
};

/**
 * MAY THIS CALLER WRITE TO THIS DEMO TENANT?
 *
 * Distinct from `refuseRefresh` on purpose. That one authorises DESTRUCTION and its message says so.
 * This authorises a repair — a ledger backfill, a column fill, a date shift — on a tenant whose
 * data is invented. The two conditions for a LISTED demo are the same because the targeting
 * discipline is the same: a list entry is a claim written once, `is_internal` is the fact that
 * makes it true, checked at the moment of use.
 *
 * ── THE DEFAULT IS UNCHANGED, DELIBERATELY ──────────────────────────────────────────────────────
 * Called with two arguments — every caller that existed before 2026-11-02, and every cron that
 * ever will — the reference demo still refuses `not_listed`, with the same message. The override
 * branch is not merely unsatisfied for an automation caller, it is UNREACHABLE: `actor` must say
 * 'operator' before the reference demo is even looked up. So adding this parameter cannot have
 * opened anything, which is a claim demo-maintenance-guard-gate asserts over the whole matrix
 * rather than leaving to be read off the code.
 *
 * ── A FLAG IN THE WRONG HANDS NAMES ITSELF ──────────────────────────────────────────────────────
 * `flagged` from an automation caller is checked FIRST and refused with its own code. It means a
 * cron has acquired the override from somewhere, which is the exact failure this exists to prevent
 * — more alarming than whatever else is wrong with the request, so it is what the message says.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────────────
 * scripts/payment-backfill refused every `is_demo` tenant outright, on the reasoning that nothing
 * in a demo is real. True, and it is exactly why a demo needs the repair — its 743 paid invoices
 * had no Payment rows, so the dashboard a prospect sees first read £0.00 revenue. "Not real" is an
 * argument about what the data MEANS, not about whether it should be self-consistent.
 *
 * PURE, so a gate can prove every refusal without a database, a terminal or a tenant. The TTY and
 * the typed ref are the SCRIPT's job; what arrives here is the script stating that it got them.
 */
export function refuseDemoMaintenance(
  /** The ref the caller named. Keyed on ref for the same reason refuseRefresh is — see the field. */
  ref: string,
  group: { ref: string | null; is_internal: boolean | null; is_demo: boolean } | null,
  req?: MaintenanceRequest,
): RefreshRefusal | null {
  const operator = req?.actor === 'operator';
  const flagged = req?.override?.flagged === true;

  // THE ALARMING COMBINATION, before anything else is considered. A cron holding the override is a
  // worse fact than a cron pointed at the wrong tenant, and an error naming the lesser cause sends
  // the next reader to the wrong place.
  if (flagged && !operator) {
    return {
      code: 'override_not_available_to_automation',
      message: `${ref}: the reference-demo override was passed by a caller that did not declare itself `
        + `an operator. It is available only to a one-off script run by a person, never to a cron, a `
        + `sweep or a lifecycle job. If this IS such a script, it must say so (actor: 'operator').`,
    };
  }

  if (isListedDemoTenant(ref)) {
    if (!group) return { code: 'not_found', message: `${ref} is listed as a demo tenant but does not exist.` };
    // THE SECOND CONDITION, checked against the database at the moment of use. A list entry is a
    // claim; this is the fact that makes it true.
    if (group.is_internal !== true) {
      return {
        code: 'not_internal',
        message: `${group.ref ?? ref} is listed but is NOT is_internal. Something has changed since it `
          + `was listed — check the tenant before the list.`,
      };
    }
    return null;
  }

  // ── THE OPERATOR OVERRIDE, and it is a LADDER: each rung names what is missing ────────────────
  if (operator && isReferenceDemo(ref)) {
    if (!flagged) {
      return {
        code: 'reference_demo',
        message: `${ref} is the frozen reference demo. A one-off script may write to it, but only when `
          + `the operator says so explicitly — pass --allow-reference-demo and type the ref when asked.`,
      };
    }
    if (req?.write === true && req?.override?.confirmed !== true) {
      return {
        code: 'not_confirmed',
        message: `${ref}: --allow-reference-demo was passed but the ref was not typed back. A write to the `
          + `reference demo is confirmed at a keyboard; a dry run needs no confirmation.`,
      };
    }
    if (!group) return { code: 'not_found', message: `${ref} is declared a reference demo but does not exist.` };
    // BOTH FACTS, read from the row now. The override permits writing to a tenant whose data is
    // INVENTED and whose records are OURS; a row that has stopped being either is a different
    // tenant wearing a listed ref, and the flag must not carry over to it.
    if (group.is_demo !== true) {
      return {
        code: 'not_demo',
        message: `${group.ref ?? ref} is declared a reference demo but is NOT is_demo. The override applies `
          + `only to a tenant whose data is invented — refusing to write to one that is not.`,
      };
    }
    if (group.is_internal !== true) {
      return {
        code: 'not_internal',
        message: `${group.ref ?? ref} is declared a reference demo but is NOT is_internal. Something has `
          + `changed since it was declared — check the tenant before the list.`,
      };
    }
    return null;
  }

  // FLAGGED, BY AN OPERATOR, AT SOMETHING ELSE. Its own code: the override is not a skeleton key,
  // and "you pointed it at the wrong tenant" is a different sentence from "this tenant is not a
  // declared demo".
  if (operator && flagged) {
    return {
      code: 'override_target_not_listed',
      message: `${ref} is not declared in lib/demo-tenants::REFERENCE_DEMOS, so --allow-reference-demo `
        + `does not authorise it. The override names one tenant; it is not a general exemption.`,
    };
  }

  return {
    code: 'not_listed',
    message: `${ref} is a demo tenant but is not declared in lib/demo-tenants::DEMO_TENANTS. `
      + `Maintenance scripts write only to declared demos — which excludes the frozen reference demo, `
      + `deliberately absent from that list.`,
  };
}

// ── IS ANYONE USING IT? (2026-09-11) ─────────────────────────────────────────────────────────────
/**
 * DEMO TENANTS HAVE REAL PEOPLE IN THEM NOW. The owner gives prospects access to the demo sites, and a
 * refresh deletes the whole tenant and breaks every session on it. This is the stop between an
 * operator and deleting someone's demo mid-sentence (owner, 2026-09-11) — NOT a fix for the shared
 * login, and not a guarantee.
 *
 * WHAT IT CAN SEE: sessions are JWTs, so the database holds no session to look at. It reads the
 * TRACES a person leaves in the last ACTIVITY_WINDOW_MINUTES: a sign-in to the tenant (the shared
 * owner login included — that is the prospect signal), a change a person made (AuditLog with a user),
 * a message a person sent, a new customer, job card or booking.
 *
 * WHAT IT CANNOT SEE, AND SAYS SO EVERY TIME: someone who signed in more than an hour ago and is only
 * READING leaves no trace. That is the MOST LIKELY prospect — given access, browsing at leisure — so a
 * pass must never read as "nobody is there". It reads as "no traces in the last hour".
 */
export const ACTIVITY_WINDOW_MINUTES = 60;

export type TenantActivity = {
  lastSignIn: Date | null;
  personChanges: number; latestPersonChange: Date | null;
  messagesByPeople: number; latestMessage: Date | null;
  newRecords: number; latestNewRecord: Date | null;
};

export const ACTIVITY_BLIND_SPOT =
  'This check cannot see someone who signed in more than an hour ago and is only reading — the most likely prospect, '
  + 'browsing at leisure. Passing means NO TRACES in the last hour, not that nobody is there.';

const ago = (d: Date, now: Date) => `${Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000))} min ago`;

/** The traces seen, in words — never who. Empty when there are none. */
export function describeActivity(a: TenantActivity, now: Date): string[] {
  const since = now.getTime() - ACTIVITY_WINDOW_MINUTES * 60_000;
  const within = (d: Date | null) => d != null && d.getTime() >= since;
  const out: string[] = [];
  if (within(a.lastSignIn)) out.push(`a sign-in ${ago(a.lastSignIn!, now)}`);
  if (a.personChanges > 0) out.push(`${a.personChanges} change${a.personChanges === 1 ? '' : 's'} by a person${a.latestPersonChange ? ` (latest ${ago(a.latestPersonChange, now)})` : ''}`);
  if (a.messagesByPeople > 0) out.push(`${a.messagesByPeople} message${a.messagesByPeople === 1 ? '' : 's'} sent by a person${a.latestMessage ? ` (latest ${ago(a.latestMessage, now)})` : ''}`);
  if (a.newRecords > 0) out.push(`${a.newRecords} new record${a.newRecords === 1 ? '' : 's'}${a.latestNewRecord ? ` (latest ${ago(a.latestNewRecord, now)})` : ''}`);
  return out;
}

/**
 * REFUSE while there are traces — unless the operator has said, explicitly, `--even-if-active`.
 * PURE. The pass and the override both still carry ACTIVITY_BLIND_SPOT: the caller prints `report`.
 */
export function refuseRefreshWhileActive(ref: string, a: TenantActivity, now: Date, evenIfActive: boolean):
  { refuse: boolean; overridden: boolean; report: string } {
  const seen = describeActivity(a, now);
  if (!seen.length) {
    return { refuse: false, overridden: false,
      report: `No traces of anyone on ${ref} in the last ${ACTIVITY_WINDOW_MINUTES} minutes. ${ACTIVITY_BLIND_SPOT}` };
  }
  const traces = `Someone has been using ${ref} in the last ${ACTIVITY_WINDOW_MINUTES} minutes: ${seen.join('; ')}.`;
  if (evenIfActive) {
    return { refuse: false, overridden: true,
      report: `${traces} OVERRIDDEN with --even-if-active — their work will be deleted and their session broken. ${ACTIVITY_BLIND_SPOT}` };
  }
  return { refuse: true, overridden: false,
    report: `${traces} Regenerating now would delete their work and break their session. Re-run later, or pass --even-if-active if you are sure. ${ACTIVITY_BLIND_SPOT}` };
}
