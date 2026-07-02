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
import { JobStatus, StageKey, QUOTE_DONE_STATUSES, INVOICE_DONE_STATUSES } from './jobcard-status';

export const TAB_KEYS = ['details', 'quote', 'intake', 'injob', 'completion', 'invoice'] as const;
export type TabKey = typeof TAB_KEYS[number];

export type TabState = { reachable: boolean; complete: boolean };

export type CardGateState = {
  status: JobStatus;
  stages: Record<StageKey, boolean>;
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
  const detailsComplete = !!s.stages.details;
  const quoteComplete = QUOTE_DONE_STATUSES.includes(s.status);
  const intakeComplete = !!s.stages.intake;
  const injobComplete = !!s.stages.injob;
  const completionComplete = !!s.stages.complete;
  const invoiceComplete = INVOICE_DONE_STATUSES.includes(s.status);

  const tabs: Record<TabKey, TabState> = {
    details: { reachable: true, complete: detailsComplete },
    quote: { reachable: detailsComplete, complete: quoteComplete },
    intake: { reachable: quoteComplete, complete: intakeComplete },
    injob: { reachable: intakeComplete, complete: injobComplete },
    completion: { reachable: injobComplete, complete: completionComplete },
    invoice: { reachable: completionComplete, complete: invoiceComplete },
  };

  // Cancelled: everything viewable (read-only). Reachability opened so history isn't stranded; the
  // page renders a cancelled banner and disables mutating controls. Completeness reflects reality.
  if (s.status === 'cancelled') {
    for (const k of TAB_KEYS) tabs[k] = { reachable: true, complete: tabs[k].complete };
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
