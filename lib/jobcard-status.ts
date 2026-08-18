/**
 * File: lib/jobcard-status.ts
 * THE single source of truth for the job-card lifecycle: the valid transitions, each transition's
 * authority kind (operational vs commercial), and its gate. The API enforces these; the UI reads
 * them to offer only valid+permitted actions. Status values are stable lowercase keys — translate
 * for display via t('jobcard:status.<key>'), never show raw.
 */
export type JobStatus =
  | 'draft' | 'quoted' | 'accepted' | 'declined'
  | 'in_progress' | 'invoiced' | 'paid' | 'done' | 'cancelled' | 'no_show';

// operational = any site-assigned user (incl. STANDARD mechanics); commercial = manager/admin only.
export type TransitionKind = 'operational' | 'commercial';
// estimate_exists: ≥1 line item; all_stages_done: all four stage flags true; booking_exists: the
// card holds a real slot (isBookedCard) — a no-show without a booking is a claim about nothing.
export type TransitionGate = 'estimate_exists' | 'all_stages_done' | 'booking_exists';
export type Transition = { to: JobStatus; kind: TransitionKind; gate?: TransitionGate };

export const JOB_STATUSES: JobStatus[] = [
  'draft', 'quoted', 'accepted', 'declined', 'in_progress', 'invoiced', 'paid', 'done', 'cancelled', 'no_show',
];

/**
 * A SUBSET OF STATUSES, TOTAL BY CONSTRUCTION. Every membership list built from this is a
 * Record<JobStatus, boolean>, so adding a status FAILS TO COMPILE at every list until someone
 * decides whether the new status belongs — the same guarantee PAY_STATE_BY_STATUS already gives
 * the money label. Bare arrays don't do this: five times in one week a new value was added and its
 * readers were found by accident, because an array is silent about the value it doesn't mention.
 */
export const statusSubset = (decisions: Record<JobStatus, boolean>): JobStatus[] =>
  JOB_STATUSES.filter((s) => decisions[s]);

// Milestone membership sets (NOT a numeric rank — the lifecycle branches: declined/cancelled are not
// "further along" than accepted). The tab chokepoint reads these to decide Quote/Invoice completeness.
export const QUOTE_DONE_STATUSES: JobStatus[] = ['accepted', 'in_progress', 'invoiced', 'paid', 'done'];
export const INVOICE_DONE_STATUSES: JobStatus[] = ['invoiced', 'paid', 'done'];

// TERMINAL-INACTIVE: a card in one of these does NOT occupy a resource slot. ONE definition, shared by
// the diary DISPLAY reader (lib/diary-day) and the occupancy GUARD (lib/diary-booking), so the two can
// never disagree on what "occupied" means. (The slot data is deliberately KEPT — the record of when/
// where the job had been booked survives — but it no longer blocks the lift or shows on the board.)
export const OFF_DIARY_STATUSES: JobStatus[] = statusSubset({
  draft: false, quoted: false, accepted: false, in_progress: false,
  invoiced: false, paid: false, done: false,
  declined: true, cancelled: true,
  // A no-show frees the slot the moment it is marked — the customer is not coming, and the lift
  // should take a walk-in. The slot data survives (same rule as cancelled): the record of when
  // they had been booked is exactly what the no-show count is built on.
  no_show: true,
});

/**
 * IS THIS CARD IN THE DIARY? The booking fact is `resource_id + start_at + end_at` — a lift and a
 * planned time. It is NOT a status and must never become one: the card already holds it, and a
 * second copy is a second thing to keep in step.
 *
 * `booking.moved` audit rows are HISTORY, not state — they record that a booking changed, not that
 * one exists, so they are deliberately not consulted.
 *
 * The same three fields are the test in lib/jobcard-page-data (the card's "Booked" chip) and, in
 * SQL form, in lib/diary-day and lib/diary-booking (`resource_id: { not: null }` + an overlapping
 * start_at/end_at range). Those two cannot literally call this — one is a Prisma where clause —
 * but they must agree with it, so any change here is a change to all three. `end_at` is included
 * because it is what the diary actually renders against; a card with a start and no end has no
 * footprint to occupy.
 */
export function isBookedCard(card: { resource_id: string | null; start_at: Date | null; end_at: Date | null }): boolean {
  return !!card.resource_id && !!card.start_at && !!card.end_at;
}

// NO-SHOW is a different fact from cancellation: a cancellation is notice, a no-show is silence.
// It is reachable only from the pre-work statuses — a card whose work has started cannot become a
// no-show, and the table refuses it rather than anyone remembering it — and only on a card that
// actually held a slot (the booking_exists gate). One exit, like cancelled: reopen to draft, for
// the customer who turns up an hour late or the mis-click.
const TRANSITIONS: Record<JobStatus, Transition[]> = {
  draft: [{ to: 'quoted', kind: 'commercial', gate: 'estimate_exists' }, { to: 'cancelled', kind: 'commercial' }, { to: 'no_show', kind: 'commercial', gate: 'booking_exists' }],
  quoted: [{ to: 'accepted', kind: 'commercial' }, { to: 'declined', kind: 'commercial' }, { to: 'cancelled', kind: 'commercial' }, { to: 'no_show', kind: 'commercial', gate: 'booking_exists' }],
  declined: [{ to: 'accepted', kind: 'commercial' }, { to: 'cancelled', kind: 'commercial' }], // declined → accepted = reopen
  accepted: [{ to: 'in_progress', kind: 'operational' }, { to: 'cancelled', kind: 'commercial' }, { to: 'no_show', kind: 'commercial', gate: 'booking_exists' }],
  in_progress: [{ to: 'invoiced', kind: 'commercial', gate: 'all_stages_done' }, { to: 'cancelled', kind: 'commercial' }],
  invoiced: [{ to: 'paid', kind: 'commercial' }, { to: 'cancelled', kind: 'commercial' }],
  paid: [{ to: 'done', kind: 'commercial' }],
  done: [],
  cancelled: [{ to: 'draft', kind: 'commercial' }], // reopen to a live state
  no_show: [{ to: 'draft', kind: 'commercial' }],   // reopen — and the derived count corrects itself
};

export function nextTransitions(from: JobStatus): Transition[] {
  return TRANSITIONS[from] ?? [];
}

export function findTransition(from: JobStatus, to: JobStatus): Transition | null {
  return (TRANSITIONS[from] ?? []).find((tr) => tr.to === to) ?? null;
}

// ---- payment state (the at-a-glance Unpaid/Invoiced/Paid label) ----
// DERIVED from the card's lifecycle status — the same single truth the tabs/gates read; never a
// stored column. `paid` covers BOTH pending-clearance and confirmed (clearance is an INVOICE-level
// distinction; the card sits at `paid` for either) plus `done`. Everything earlier — including
// declined/cancelled — is simply "unpaid": nothing chargeable has been raised.
// A COMEBACK's invoice settles at issue (£0, terminal — never paid): its card reads `settled`
// from `invoiced` onward, so a warranty job never looks like outstanding money.
export type PaymentState = 'unpaid' | 'invoiced' | 'paid' | 'settled' | 'unknown';

/**
 * EVERY JobStatus, NAMED. This is a Record<JobStatus, …>, so adding a status to JobStatus FAILS TO
 * COMPILE until someone decides what it means for money. That is the point of the map: the previous
 * version ended in a bare `return 'unpaid'`, so a new status would silently have been presented as
 * an unpaid job — the same fault that made a voided invoice read as £96.00 outstanding on the
 * Invoices list. Prophylaxis: no void reaches this today, and no existing status changes behaviour.
 */
const PAY_STATE_BY_STATUS: Record<JobStatus, PaymentState> = {
  draft: 'unpaid', quoted: 'unpaid', accepted: 'unpaid', declined: 'unpaid',
  in_progress: 'unpaid', cancelled: 'unpaid', no_show: 'unpaid',
  invoiced: 'invoiced',
  paid: 'paid', done: 'paid',
};

export function paymentState(status: JobStatus | string, isComeback = false): PaymentState {
  if (isComeback && (status === 'invoiced' || status === 'paid' || status === 'done')) return 'settled';
  // An unrecognised status is UNKNOWN — never a specific financial state. Callers render the raw
  // status rather than a money label, so it looks unknown instead of looking settled.
  return PAY_STATE_BY_STATUS[status as JobStatus] ?? 'unknown';
}

// ---- the four operational stage flags ----
export const STAGE_KEYS = ['details', 'intake', 'injob', 'complete'] as const;
export type StageKey = typeof STAGE_KEYS[number];
export const STAGE_COLUMN: Record<StageKey, 'stage_details_done' | 'stage_intake_done' | 'stage_injob_done' | 'stage_complete_done'> = {
  details: 'stage_details_done',
  intake: 'stage_intake_done',
  injob: 'stage_injob_done',
  complete: 'stage_complete_done',
};

export function isStageKey(v: unknown): v is StageKey {
  return typeof v === 'string' && (STAGE_KEYS as readonly string[]).includes(v);
}

// ---- soft-gate skips (photo/capture stages only — Details is a data gate, never skippable) ----
// complete OR skipped advances the spine; the all_stages_done gate reads (done || skipped) for these.
export const SKIPPABLE_STAGES = ['intake', 'injob', 'complete'] as const;
export type SkippableStage = typeof SKIPPABLE_STAGES[number];
export const SKIP_COLUMN: Record<SkippableStage, 'stage_intake_skipped' | 'stage_injob_skipped' | 'stage_complete_skipped'> = {
  intake: 'stage_intake_skipped',
  injob: 'stage_injob_skipped',
  complete: 'stage_complete_skipped',
};
export function isSkippableStage(v: unknown): v is SkippableStage {
  return typeof v === 'string' && (SKIPPABLE_STAGES as readonly string[]).includes(v);
}
