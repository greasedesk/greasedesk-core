/**
 * File: lib/jobcard-tabs.ts
 * THE single source of truth for the six-tab process path's gating. One PURE function, no I/O:
 * given a card's state (status + the four stage flags + Customer-Details data presence), it returns
 * each tab's { reachable, complete }. BOTH the SSR page (to grey/lock tabs) AND the mutation APIs
 * (to refuse out-of-order actions) read this, so the UI's greying and the server's refusal can never
 * disagree — out-of-order actions are impossible, not merely hidden.
 *
 * Gating is mixed-mechanism (not uniform prior-flag):
 *   Customer Details — ALWAYS reachable; complete = details stage flag (settable only with min data).
 *   Quote           — reachable once Details complete; complete = status reached `accepted` (QUOTE_DONE).
 *   Intake / In-Job / Completion — reachable once the prior is complete; complete = that stage flag.
 *   Invoice         — reachable once Completion complete; complete = status `invoiced`+ (INVOICE_DONE).
 *
 * Branch-honest: `declined` leaves Quote incomplete → everything downstream stays locked. `cancelled`
 * makes every tab reachable (so the finished/killed card stays fully viewable) but read-only — the
 * page renders a cancelled banner and disables actions.
 */
// TYPES SPLIT FROM VALUES. JobStatus and StageKey are types; imported as values they survive
// type-stripping as a runtime import of something that does not exist, which broke every gate that
// tried to import this module. Same lesson as InvoiceTotals earlier — `import type` is not a style
// preference here, it is what makes the file loadable outside a bundler.
import type { JobStatus, StageKey } from './jobcard-status';
import { QUOTE_DONE_STATUSES, INVOICE_DONE_STATUSES } from './jobcard-status';

export const TAB_KEYS = ['details', 'messages', 'quote', 'intake', 'injob', 'completion', 'invoice', 'refund'] as const;

/**
 * NOT PART OF THE GATED SPINE. Messages is a place to look, not a step to finish: always reachable,
 * never completable, and it gates nothing after it. Quote's reachability skips straight over it and
 * still depends on Details.
 *
 * Stated as a list rather than left implicit because the next person adding a tab will copy
 * whichever one they read first, and every other entry in TAB_KEYS is a stage. The gate asserts
 * this set never gains a `complete: true`.
 */
export const NON_STAGE_TABS: readonly TabKey[] = ['messages', 'refund'];
export type TabKey = typeof TAB_KEYS[number];

export type TabState = { reachable: boolean; complete: boolean; skipped?: boolean };

export type CardGateState = {
  status: JobStatus;
  stages: Record<StageKey, boolean>;
  // Soft-gate skips (photo stages only): a skipped stage ADVANCES the spine like a completed one
  // (complete OR skipped), but is displayed distinctly. Details never skips (data gate).
  skipped?: Partial<Record<StageKey, boolean>>;
  hasOwner: boolean;         // a current owner resolves via the VehicleOwnership edge
  hasRegistration: boolean;  // the car has a registration
};

// The stage flag that backs each stage-gated tab (Quote/Invoice gate on status, not a flag → absent).
export const TAB_STAGE: Partial<Record<TabKey, StageKey>> = {
  details: 'details', intake: 'intake', injob: 'injob', completion: 'complete',
};

/** Customer Details may only be marked complete when the minimum owner + vehicle data is present. */
export function detailsMinDataMet(s: Pick<CardGateState, 'hasOwner' | 'hasRegistration'>): boolean {
  return s.hasOwner && s.hasRegistration;
}

export function computeTabs(s: CardGateState): Record<TabKey, TabState> {
  const skippedOf = (k: StageKey) => !s.stages[k] && !!s.skipped?.[k]; // display: skipped-not-done
  const advanced = (k: StageKey) => !!s.stages[k] || !!s.skipped?.[k]; // spine: complete OR skipped
  const detailsComplete = !!s.stages.details; // Details is done-only — never skippable
  const quoteComplete = QUOTE_DONE_STATUSES.includes(s.status);
  const intakeComplete = advanced('intake');
  const injobComplete = advanced('injob');
  const completionComplete = advanced('complete');
  const invoiceComplete = INVOICE_DONE_STATUSES.includes(s.status);

  const tabs: Record<TabKey, TabState> = {
    details: { reachable: true, complete: detailsComplete },
    // ALWAYS REACHABLE, NEVER COMPLETABLE. A customer can write in before anything else has
    // happened, so locking it behind Details would hide the message that explains the job. And
    // "complete" is meaningless for a conversation — it is never finished, only quiet.
    messages: { reachable: true, complete: false },
    // Quote still gates on DETAILS, not on the tab before it in the list. Reading the order as the
    // dependency chain is the mistake this comment exists to stop.
    quote: { reachable: detailsComplete, complete: quoteComplete },
    intake: { reachable: quoteComplete, complete: intakeComplete, skipped: skippedOf('intake') },
    injob: { reachable: intakeComplete, complete: injobComplete, skipped: skippedOf('injob') },
    completion: { reachable: injobComplete, complete: completionComplete, skipped: skippedOf('complete') },
    invoice: { reachable: completionComplete, complete: invoiceComplete },
    // ALWAYS REACHABLE, NEVER COMPLETABLE — like Messages, and for a related reason: a refund is
    // not a step in getting the job out of the door, it is something that may or may not ever
    // happen afterwards. "Complete" is meaningless for it.
    //
    // ALWAYS VISIBLE, rather than appearing only when something is refundable. A garage looking for
    // the refund control and not finding it concludes the product cannot do refunds; a tab that
    // opens and says "no money has been taken on this job yet" costs one click and answers the
    // question. The panel carries the honest empty state — see components/refund/RefundPanel.
    refund: { reachable: true, complete: false },
  };

  // Cancelled: everything viewable (read-only). Reachability opened so history isn't stranded; the
  // page renders a cancelled banner and disables mutating controls. Completeness reflects reality.
  if (s.status === 'cancelled') {
    for (const k of TAB_KEYS) tabs[k] = { ...tabs[k], reachable: true };
  }
  return tabs;
}

/** Tab that owns a given stage flag (for the stage API's reachability guard). */
export function tabForStage(stage: StageKey): TabKey {
  switch (stage) {
    case 'details': return 'details';
    case 'intake': return 'intake';
    case 'injob': return 'injob';
    case 'complete': return 'completion';
  }
}
