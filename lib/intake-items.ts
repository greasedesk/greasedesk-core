/**
 * File: lib/intake-items.ts
 * THE FOUR INTAKE PROMPTS — what a mechanic is asked before the car enters the bay, whether each
 * has been done, and the shape of a skip.
 *
 * ── PROMPT, NEVER GATE ──────────────────────────────────────────────────────────────────────────
 * Every item here is a question, not a lock. A mechanic may proceed with any of them undone. A hard
 * gate gets worked around — a photo of the floor, a typed-in zero — and the data ends up LOOKING
 * captured when it isn't, which is worse than an honest gap. The pressure is the escalation, and
 * the escalation only works if it is believed.
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

/** The photo slot that satisfies the diagnostic-scan item — a photo of the scanner screen. */
export const DIAG_SCAN_SLOT = 'diag_scan';

/** Everything the done-states are derived FROM. Gathered by the caller; this file stays pure. */
export type IntakeFacts = {
  dueItemCount: number;          // findings recorded on THIS card
  nothingFoundAt: Date | null;   // the affirmative
  odometerIn: number | null;
  vin: string | null;
  hasIntakeVideo: boolean;
  hasDiagScanPhoto: boolean;
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
    case 'diag_scan': return f.hasDiagScanPhoto;
    // ANY recorded level, including a healthy one. The affirmative IS the artefact here — there is
    // no version of this item satisfied only by finding something wrong.
    case 'oil_level': return f.oilLevelAt != null;
  }
}

/**
 * The four items as the screen and the escalation both see them.
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
