/**
 * File: lib/due-item-closure.ts
 * WHY A FINDING CLOSED, in one place, because the reason decides what a customer is shown.
 *
 * ── THE OUTCOMES DIVERGE, SO FREE TEXT WAS NOT ENOUGH ───────────────────────────────────────────
 * `closed_reason` already held good sentences and could not be branched on. These three can:
 *
 *   fixed              the garage did it on this visit. It belongs on the document as work DONE.
 *   declined           the customer said no. It must never read as done.
 *   no_longer_applies  superseded, re-checked, retracted, scheduled away. Silent.
 *
 * The words stay: a kind without a sentence tells a garage nothing when they open the car's
 * history in a year. Every closure carries both.
 *
 * ── AND `fixed` IS THE ONLY ONE THAT REACHES A CUSTOMER ─────────────────────────────────────────
 * That is the whole reason the type exists. A closure that prints is a claim the garage did
 * something, so it is a claim that has to be made deliberately — not inferred from a closure with
 * no reason at all, which is what every closure before 2026-08-20 was.
 */

export const CLOSED_KINDS = ['fixed', 'declined', 'no_longer_applies'] as const;
export type ClosedKind = (typeof CLOSED_KINDS)[number];

export const isClosedKind = (v: unknown): v is ClosedKind =>
  typeof v === 'string' && (CLOSED_KINDS as readonly string[]).includes(v);

/** What the garage picks, in the garage's words. */
export const CLOSED_KIND_LABEL: Record<ClosedKind, string> = {
  fixed: 'We sorted it',
  declined: 'Customer declined',
  no_longer_applies: 'No longer applies',
};

/**
 * ONLY `fixed` PRINTS. Not a rendering preference — a declined item printed as done would tell a
 * customer their garage did work they refused, on a document they keep.
 */
export const printsAsWorkDone = (kind: string | null | undefined): boolean => kind === 'fixed';

/**
 * The default sentence for a kind, when the closer did not type one. A stored NULL reason is what
 * made today's closures unreadable; a sentence that says only as much as the kind does is still
 * more than nothing, and a typed note replaces it.
 */
export const DEFAULT_CLOSED_REASON: Record<ClosedKind, string> = {
  fixed: 'Done on this visit',
  declined: 'Customer declined',
  no_longer_applies: 'No longer applies',
};

export type CloseInput = { kind: ClosedKind; note?: string | null; jobCardId?: string | null };
export type CloseRefusal = { code: string; message: string };

/**
 * ── `fixed` DEMANDS A CARD, AND THE OTHER TWO DO NOT ────────────────────────────────────────────
 * "We sorted it" is a claim about a VISIT: it prints on that visit's invoice, and a fixed closure
 * with no card is a claim nobody can place. Declining, by contrast, genuinely happens away from a
 * job — a phone call in March about a finding from January — and demanding a card there would make
 * the honest answer unrecordable.
 *
 * PURE, so the rule is provable without a row.
 */
export function refuseClosure(input: CloseInput): CloseRefusal | null {
  if (!isClosedKind(input.kind)) {
    return { code: 'bad_kind', message: 'Say why this is being closed.' };
  }
  if (input.kind === 'fixed' && !input.jobCardId) {
    return { code: 'fixed_needs_card', message: 'A finding we sorted belongs to the visit we sorted it on — open it from the job card.' };
  }
  if ((input.note ?? '').length > 300) {
    return { code: 'note_too_long', message: 'Keep the note under 300 characters.' };
  }
  return null;
}

/** The columns to write. One shape, so no caller invents its own combination. */
export function closureFields(input: CloseInput, at: Date = new Date()) {
  return {
    closed_at: at,
    closed_kind: input.kind,
    closed_reason: (input.note ?? '').trim().slice(0, 300) || DEFAULT_CLOSED_REASON[input.kind],
    // Null for a closure that genuinely belongs to no visit. refuseClosure has already insisted
    // on one for `fixed`.
    closed_job_card_id: input.jobCardId ?? null,
  };
}

/**
 * ── WHAT THIS VISIT SORTED, for the customer's document ─────────────────────────────────────────
 * Scoped to the CARD, not the car: the block describes this visit, so it shows findings closed
 * with this card's id, whichever they are. Two entries about one car's oil in one visit is honest
 * if that is what happened — and if it reads oddly, that is a signal the recording is too granular,
 * not that the block is wrong.
 *
 * Frozen at mint like every other part of the document, and formatted here so the PDF and the
 * screen cannot drift. NULL when there is nothing — an empty heading is worse than no heading.
 */
export function printedWorkDoneBlock(items: Array<{ description: string; closedKind: string | null }>): string | null {
  const done = items.filter((i) => printsAsWorkDone(i.closedKind));
  if (!done.length) return null;
  return done.map((i, n) => `(${n + 1}) ${i.description}`).join('\n');
}
