/**
 * File: lib/intake-items.ts
 * THE FOUR INTAKE PROMPTS — what a mechanic is asked before the car enters the bay, whether each
 * has been done, and the shape of a skip.
 *
 * ── PROMPT, NEVER GATE ──────────────────────────────────────────────────────────────────────────
 * Every item here is a question, not a lock. A mechanic may proceed with any of them undone. A hard
 * gate gets worked around — a photo of the floor, a typed-in zero — and the data ends up LOOKING
 * captured when it isn't, which is worse than an honest gap. The pressure is the escalation
 * (lib/intake-escalation, fired from pages/api/jobcard-stage when intake is marked done), and it
 * only works if it is believed.
 *
 * That sentence was in this file for a fortnight before any sender existed. It read as a
 * description and was an intention — see the note on stating intent at the foot of this header.
 *
 * ── EVERY DONE-STATE IS DERIVED FROM THE ARTEFACT ───────────────────────────────────────────────
 * Not a per-item flag. A flag needs a writer on every path that could satisfy the item — including
 * the phone, which uploads photos through an API that knows nothing about this file — and it drifts
 * the first time one of them is missed. Derive it, and capturing the artefact by ANY route makes
 * the item done, including retrospectively.
 *
 * ── AND WHY "NOTHING FOUND" IS AN ARTEFACT TOO ──────────────────────────────────────────────────
 * `findings` cannot be "at least one due item exists": a car that genuinely needs nothing would
 * then be unsatisfiable, forcing a mechanic who did the job properly to skip, and generating a
 * false escalation. An admin who gets those stops reading, and once the email is ignored the whole
 * design is dead. So ABSENCE OF FINDINGS IS NOT ABSENCE OF LOOKING: the affirmative is its own
 * record, with an actor and a timestamp, and it satisfies the item exactly as a finding does.
 *
 * ── STATING INTENT: SAY "NOT BUILT", IN THOSE WORDS ─────────────────────────────────────────────
 * Five files in this feature described the escalation in the present tense — "the pressure is the
 * escalation", "the escalation comes free" — while `intakeOutstanding` had zero callers and no
 * template, cron or sender existed anywhere. Each was written in good faith while building toward
 * the thing it anticipated, and together they were convincing enough that the gap was nearly
 * written into a customer-facing offer as a promise, sourced from these comments rather than code.
 *
 * THE RULE: a comment saying what the system DOES must be distinguishable from one saying what it
 * is FOR. Intent is written as `NOT BUILT —` followed by what would have to be true, and never in
 * the present tense. A description names the file that makes it true, so a reader can follow it and
 * check. See lib/intake-escalation's note on the deferred sweep for the shape.
 */

export const INTAKE_ITEMS = ['findings', 'mileage_vin', 'walkaround', 'diag_scan', 'oil_level'] as const;
export type IntakeItem = typeof INTAKE_ITEMS[number];

/** The Site column that switches each prompt on. TOTAL — a new item must name its switch. */
export const INTAKE_SWITCH: Record<IntakeItem, 'intake_prompt_findings' | 'intake_prompt_mileage_vin' | 'intake_prompt_walkaround' | 'intake_prompt_diag_scan' | 'intake_prompt_oil_level'> = {
  findings: 'intake_prompt_findings',
  mileage_vin: 'intake_prompt_mileage_vin',
  walkaround: 'intake_prompt_walkaround',
  diag_scan: 'intake_prompt_diag_scan',
  oil_level: 'intake_prompt_oil_level',
};

/**
 * THE PRISMA `select` FOR THE SWITCHES, derived from the map above.
 *
 * ── WHY THIS IS NOT FIVE LITERALS ───────────────────────────────────────────────────────────────
 * INTAKE_SWITCH is a total Record, so a new item cannot be added without naming its column. That
 * protects exactly one file. Everywhere else the four column names were written out by hand — two
 * Prisma selects, a view type, a gssp mapping and a checkbox list — and each of those had quietly
 * become a second source of truth.
 *
 * The cost was not theoretical. `oil_level` shipped with its switch, its endpoint, its chips and
 * its gate, and was UNREACHABLE: lib/jobcard-page-data selected four columns by name, so the fifth
 * was never loaded, read as `undefined`, and the item could never be prompted — not even by setting
 * the column directly in the database.
 *
 * Derive the select and a sixth item appears everywhere at once, or fails to compile.
 */
export const INTAKE_PROMPT_SELECT = Object.fromEntries(
  INTAKE_ITEMS.map((i) => [INTAKE_SWITCH[i], true as const]),
) as Record<(typeof INTAKE_SWITCH)[IntakeItem], true>;

/**
 * The switches off a site row, in the shape intakeItemStates wants.
 *
 * MISSING IS FALSE, and that is the safe direction: an unloaded column must mean "not prompted",
 * never "prompted". The opposite would put an item nobody was asked for into the escalation, which
 * is the failure the whole prompt design exists to avoid.
 */
export function promptSwitches(site: Record<string, unknown> | null | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const item of INTAKE_ITEMS) out[INTAKE_SWITCH[item]] = site?.[INTAKE_SWITCH[item]] === true;
  return out;
}

/**
 * SHOULD THIS SITE BE OFFERED THE PROMPTS? Two site facts, neither about the browser.
 *
 * ── WHY IT IS OFFERED AT ALL ────────────────────────────────────────────────────────────────────
 * Every prompt defaults OFF and the panel that switches them on lives in Settings → Locations.
 * Measured 2026-08-19: five real tenants had all five off and always had, and the only tenant with
 * any enabled was the demo. The feature was not undiscovered because it was hidden — it was
 * undiscovered because nothing on the screen where a garage would want it ever mentioned it.
 *
 * ── TWO FACTS, AND WHY "EVER ENABLED" IS NOT A THIRD ────────────────────────────────────────────
 * A garage with three of five on has made a choice; second-guessing it is the nag — so a currently
 * enabled prompt hides the offer. A garage that turned them all off after having them on has also
 * ANSWERED the question, and the offer must stay gone for them too.
 *
 * The obvious way to know that is a history of toggles, and there is none: pages/api/locations
 * writes no audit for a prompt change and SiteConfigEvent is for effective-dated capacity, not
 * this. Rather than add a history table to answer one question, the WRITER stamps
 * `intake_offer_dismissed_at` when it switches off the last remaining prompt. Turning them all off
 * IS the answer, so it is recorded as one — which collapses two facts into one flag that cannot
 * disagree with itself, and needs no retroactive history we do not have.
 *
 * PURE, so both conditions are provable without a database.
 */
export function shouldOfferIntakePrompts(site: {
  anyPromptEnabled: boolean;
  dismissedAt: Date | null;
}): boolean {
  return !site.anyPromptEnabled && site.dismissedAt == null;
}

/** True when ANY prompt is currently on for this site. */
export const anyPromptEnabled = (switches: Record<string, boolean>): boolean =>
  INTAKE_ITEMS.some((i) => switches[INTAKE_SWITCH[i]] === true);


/** Everything the done-states are derived FROM. Gathered by the caller; this file stays pure. */
export type IntakeFacts = {
  dueItemCount: number;          // findings recorded on THIS card
  nothingFoundAt: Date | null;   // the affirmative
  odometerIn: number | null;
  vin: string | null;
  hasIntakeVideo: boolean;
  /** When the scan was CONFIRMED — JobCard.diag_scan_at. Was `hasDiagScanPhoto`, a photo slot
   *  nothing ever wrote: the scan runs on an external tool and its report goes out by email, so
   *  there is no artefact to hold. NULL = nobody has ticked it. */
  diagScanAt: Date | null;
  /** The level recorded on THIS card, whatever it was. NULL = nobody looked yet.
   *  A reading of `between` satisfies the item exactly as `below_min` does — the item is "did you
   *  check", not "was there a problem", which is the same reason "nothing found" is an artefact. */
  oilLevelAt: Date | null;
};

export type IntakeItemState = {
  item: IntakeItem;
  /** Switched on for this site? An item switched off is not prompted and cannot be skipped. */
  prompted: boolean;
  done: boolean;
  /** Skipped and STILL not done — a skip is spent the moment the artefact arrives. */
  skipped: boolean;
  skipReason: string | null;
};

/** DERIVED, one place. Adding an item fails to compile here until its rule is written. */
export function intakeItemDone(item: IntakeItem, f: IntakeFacts): boolean {
  switch (item) {
    // EITHER a finding OR the affirmative. Both are evidence that somebody looked.
    case 'findings': return f.dueItemCount > 0 || f.nothingFoundAt != null;
    case 'mileage_vin': return f.odometerIn != null && !!f.vin?.trim();
    case 'walkaround': return f.hasIntakeVideo;
    // A CONFIRMATION, NOT A CAPTURE — see IntakeFacts.diagScanAt.
    case 'diag_scan': return f.diagScanAt != null;
    // ANY recorded level, including a healthy one. The affirmative IS the artefact here — there is
    // no version of this item satisfied only by finding something wrong.
    case 'oil_level': return f.oilLevelAt != null;
  }
}

/**
 * The items as the screen and the escalation (lib/intake-escalation) both see them.
 *
 * `skipped` is DERIVED AGAINST DONE, deliberately: skip the scan at 09:30 and do it at 10:00 and
 * the item is simply done — a spent skip must not follow the card around. The escalation reports
 * what is not done when the stage advances, which also catches the mechanic who never opened the
 * tab at all, not only the one who pressed skip.
 */
export function intakeItemStates(
  facts: IntakeFacts,
  switches: Record<string, boolean | null | undefined>,
  skips: Partial<Record<IntakeItem, { reason: string | null }>>,
): IntakeItemState[] {
  return INTAKE_ITEMS.map((item) => {
    const done = intakeItemDone(item, facts);
    const skip = skips[item];
    return {
      item,
      prompted: switches[INTAKE_SWITCH[item]] === true,
      done,
      skipped: !done && !!skip,
      skipReason: !done ? (skip?.reason ?? null) : null,
    };
  });
}

/**
 * WHAT THE ESCALATION REPORTS: prompted, and not done. Not "was skipped" — a mechanic who never
 * opened the tab has left the same gap as one who pressed skip, and the admin needs both.
 */
export const intakeOutstanding = (states: IntakeItemState[]): IntakeItemState[] =>
  states.filter((s) => s.prompted && !s.done);

/** The two one-tap reasons. FIXED in code, not per-tenant config: a reason list a garage can edit
 *  becomes a taxonomy nobody maintains, and the free-text box already covers everything else. */
export const SKIP_REASON_CHIPS = ['equipment_fault', 'customer_waiting'] as const;
export type SkipReasonChip = typeof SKIP_REASON_CHIPS[number];
