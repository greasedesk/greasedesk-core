/**
 * File: lib/jobcard-status.ts
 * THE single source of truth for the job-card lifecycle: the valid transitions, each transition's
 * authority kind (operational vs commercial), and its gate. The API enforces these; the UI reads
 * them to offer only valid+permitted actions. Status values are stable lowercase keys — translate
 * for display via t('jobcard:status.<key>'), never show raw.
 */
export type JobStatus =
  | 'draft' | 'quoted' | 'accepted' | 'declined'
  | 'in_progress' | 'invoiced' | 'paid' | 'done' | 'cancelled';

// operational = any site-assigned user (incl. STANDARD mechanics); commercial = manager/admin only.
export type TransitionKind = 'operational' | 'commercial';
// estimate_exists: ≥1 line item; all_stages_done: all four stage flags true.
export type TransitionGate = 'estimate_exists' | 'all_stages_done';
export type Transition = { to: JobStatus; kind: TransitionKind; gate?: TransitionGate };

export const JOB_STATUSES: JobStatus[] = [
  'draft', 'quoted', 'accepted', 'declined', 'in_progress', 'invoiced', 'paid', 'done', 'cancelled',
];

// Milestone membership sets (NOT a numeric rank — the lifecycle branches: declined/cancelled are not
// "further along" than accepted). The tab chokepoint reads these to decide Quote/Invoice completeness.
export const QUOTE_DONE_STATUSES: JobStatus[] = ['accepted', 'in_progress', 'invoiced', 'paid', 'done'];
export const INVOICE_DONE_STATUSES: JobStatus[] = ['invoiced', 'paid', 'done'];

const TRANSITIONS: Record<JobStatus, Transition[]> = {
  draft: [{ to: 'quoted', kind: 'commercial', gate: 'estimate_exists' }, { to: 'cancelled', kind: 'commercial' }],
  quoted: [{ to: 'accepted', kind: 'commercial' }, { to: 'declined', kind: 'commercial' }, { to: 'cancelled', kind: 'commercial' }],
  declined: [{ to: 'accepted', kind: 'commercial' }, { to: 'cancelled', kind: 'commercial' }], // declined → accepted = reopen
  accepted: [{ to: 'in_progress', kind: 'operational' }, { to: 'cancelled', kind: 'commercial' }],
  in_progress: [{ to: 'invoiced', kind: 'commercial', gate: 'all_stages_done' }, { to: 'cancelled', kind: 'commercial' }],
  invoiced: [{ to: 'paid', kind: 'commercial' }, { to: 'cancelled', kind: 'commercial' }],
  paid: [{ to: 'done', kind: 'commercial' }],
  done: [],
  cancelled: [{ to: 'draft', kind: 'commercial' }], // reopen to a live state
};

export function nextTransitions(from: JobStatus): Transition[] {
  return TRANSITIONS[from] ?? [];
}

export function findTransition(from: JobStatus, to: JobStatus): Transition | null {
  return (TRANSITIONS[from] ?? []).find((tr) => tr.to === to) ?? null;
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
