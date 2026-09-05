/**
 * File: lib/trial-extension.ts
 * EXTENDING A TENANT'S TRIAL FROM THE ENGINE ROOM — the rules, before anybody calls Stripe.
 *
 * ── WHY THE REFUSALS LIVE HERE AND NOT IN STRIPE'S REPLY ────────────────────────────────────────
 * Stripe rejects a trial_end inside 48 hours and one in the past, and surfacing its error would be
 * a worse answer than not sending it: the operator gets an API message about a parameter when they
 * asked a question about a trial. Every refusal below is one Stripe would also make, made first and
 * in a sentence that says what to do instead.
 *
 * ── EXTEND ONLY, AND THE REASON IS NOT SQUEAMISHNESS ────────────────────────────────────────────
 * Pulling a trial BACK is refused here. lib/commission gates accrual on Group.trial_ends_at — "no
 * commission on collected_at < trial_ends_at" — so moving the date earlier can make payments that
 * were previously excluded start accruing commission to a rep. That is a different act, with a
 * different blast radius, and it belongs to a higher role than the one this endpoint uses. Refusing
 * it by name beats letting it through a control built for the other direction.
 *
 * ── THE NOTE IS HELD TO THE VOID RULES, DELIBERATELY THE SAME ONES ──────────────────────────────
 * MIN_REASON_LENGTH and the repeated-character check come from lib/invoice-void rather than being
 * restated. Three validators for "is this an explanation" is how "x" becomes acceptable in one
 * place and not another.
 *
 * PURE. `now` is a parameter rather than a `new Date()` so a gate can pin the clock.
 */
import { MIN_REASON_LENGTH } from '@/lib/invoice-void';

/**
 * WHY a trial was extended. A fixed vocabulary, not an operator-editable table, and the same
 * argument VOID_CATEGORIES makes: the list IS the analysis. "How many trials do we extend, and
 * why" only has an answer while the words mean the same thing in March and September, and a
 * category anybody can add is a free-text field with extra steps.
 */
export const TRIAL_EXTENSION_CATEGORIES = ['beta_programme', 'technical_support', 'sales', 'goodwill'] as const;
export type TrialExtensionCategory = (typeof TRIAL_EXTENSION_CATEGORIES)[number];

/** Stripe refuses a trial_end less than this far ahead. Ours refuses it first, and says so. */
export const STRIPE_MIN_TRIAL_HOURS = 48;

export type ExtensionCheck =
  | { ok: true; next: Date; deltaDays: number; category: TrialExtensionCategory; note: string }
  | { ok: false; message: string };

export function validateExtension(input: {
  /** The trial end as it stands. NULL for a tenant that somehow has none — still extendable. */
  current?: Date | string | null;
  next?: Date | string | null;
  category?: string | null;
  note?: string | null;
  now?: Date;
}): ExtensionCheck {
  const now = input.now ?? new Date();
  const next = input.next ? new Date(input.next) : null;
  if (!next || Number.isNaN(next.getTime())) {
    return { ok: false, message: 'Pick the new date the trial should end on.' };
  }

  const hoursAhead = (next.getTime() - now.getTime()) / 3_600_000;
  if (hoursAhead <= 0) {
    return { ok: false, message: 'That date has already passed. A trial can only be extended to a date in the future.' };
  }
  // STRIPE'S OWN FLOOR, enforced before the call so the message can explain it rather than relay it.
  if (hoursAhead < STRIPE_MIN_TRIAL_HOURS) {
    return {
      ok: false,
      message: `Stripe will not accept a trial ending less than ${STRIPE_MIN_TRIAL_HOURS} hours from now. Pick a date at least two days ahead.`,
    };
  }

  // EXTEND ONLY. See the header: earlier moves the commission boundary.
  const current = input.current ? new Date(input.current) : null;
  if (current && !Number.isNaN(current.getTime()) && next.getTime() <= current.getTime()) {
    return {
      ok: false,
      message: 'This only extends a trial. Bringing the date earlier would shorten it and move the commission boundary, which is a different change and a different permission.',
    };
  }

  const category = String(input.category ?? '').trim();
  if (!(TRIAL_EXTENSION_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, message: `Choose why the trial is being extended: ${TRIAL_EXTENSION_CATEGORIES.join(', ')}.` };
  }

  const note = String(input.note ?? '').trim();
  if (!note) return { ok: false, message: 'Add a note — it is the record of what was agreed and with whom.' };
  if (note.length < MIN_REASON_LENGTH) {
    return { ok: false, message: `Give a bit more detail — at least ${MIN_REASON_LENGTH} characters.` };
  }
  // One character repeated is a placeholder, not an explanation — the void reason's own test.
  if (new Set(note.replace(/\s+/g, '')).size <= 1) {
    return { ok: false, message: 'That is not an explanation. Write what was actually agreed.' };
  }

  return {
    ok: true,
    next,
    // WHOLE DAYS FROM THE CURRENT END, which is the number an operator means by "another fortnight".
    // From `now` when there is no current end, because there is nothing to add to.
    deltaDays: Math.round((next.getTime() - (current?.getTime() ?? now.getTime())) / 86_400_000),
    category: category as TrialExtensionCategory,
    note: note.slice(0, 500),
  };
}

/** Unix seconds, which is what Stripe's `trial_end` takes. */
export const toStripeTrialEnd = (d: Date): number => Math.floor(d.getTime() / 1000);
