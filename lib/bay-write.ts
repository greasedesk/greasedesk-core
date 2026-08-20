/**
 * File: lib/bay-write.ts
 * CAN THIS JOB STILL TAKE BAY DATA? One predicate, seven writers, so the answer cannot differ by
 * which form a mechanic happens to be standing in front of.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────────────────────────
 * On 2026-08-20 a battery reading was recorded against LL67ZZK's card — status `paid`, invoice
 * issued and settled — and nothing objected. Every capture endpoint checked the tenant and the
 * site and none of them checked whether the job was over. `inactive` in the workspace meant
 * `cancelled || noShow` only, so a paid card's forms were fully live.
 *
 * What is harmed is NOT the invoice: freeze-at-issue already protects the document, and a reading
 * taken afterwards cannot reach it. What is harmed is the CAR's record. A measurement written now
 * is attributed to a visit that finished — and because TyreReading is unique on (job_card_id,
 * corner) and BatteryReading on job_card_id, a late write OVERWRITES that visit's reading rather
 * than adding to it. The visit's own history is silently rewritten, and the wear rate computed
 * from it is computed from a date nobody measured on.
 *
 * ── NOT ABSOLUTE, AND THE REOPENING ALREADY EXISTS ──────────────────────────────────────────────
 * An absolute refusal makes an honest typo uncorrectable an hour after invoicing, and people work
 * around uncorrectable systems in worse ways — a second job card, or the right number typed into
 * the description field where nothing can read it.
 *
 * So the boundary is the ADMIN UNLOCK, which is already built, already audited and already means
 * exactly this: "this document is being corrected". lib/invoice::canEditInvoice is true precisely
 * when an admin has unlocked (the frozen lines are gone), and that is when bay data may move again.
 * No second concept, no new reopen button, no per-endpoint window.
 *
 * The cost, accepted knowingly: unlocking DELETES the frozen lines, which is heavy for a
 * transposed voltage. The alternative is a lighter "reopen for bay data only", and a second way to
 * reopen a job is a second thing to reason about on every screen that asks "is this editable?".
 * One heavy path used rarely beats two paths used carelessly. Revisit if corrections turn out to
 * be common — that is evidence, and this comment is where it belongs.
 */
import { canEditInvoice } from '@/lib/invoice';

export type BayWriteCard = {
  status: string;
  /** NULL when the job never reached an invoice — most cards, and always writable. */
  invoice: { status: string; lineCount: number } | null;
};

export type BayWriteRefusal = { code: string; message: string };

/**
 * TERMINALLY INACTIVE, which is not the same as finished. A cancelled or no-show job did not
 * happen; recording what the car's tyres measured on a visit that never took place is a claim
 * about nothing. These have no unlock, because there is no document to correct.
 */
const NEVER_HAPPENED = ['cancelled', 'no_show'];

export function refuseBayWrite(card: BayWriteCard): BayWriteRefusal | null {
  if (NEVER_HAPPENED.includes(card.status)) {
    return { code: 'card_inactive', message: 'This job was cancelled, so there is nothing to record against it.' };
  }
  if (!card.invoice) return null; // no document, nothing frozen, nothing to protect
  // THE SAME PREDICATE THE LEDGER USES. Unlocked (lines dropped by an admin) → editable again.
  if (canEditInvoice({ status: card.invoice.status, hasFrozenLines: card.invoice.lineCount > 0 })) return null;
  return {
    code: 'invoice_frozen',
    message: 'This job is invoiced. Start a new job card for a new reading, or ask an admin to unlock the invoice to correct this one.',
  };
}

/** The `select` every caller needs, so no endpoint invents a narrower one and reads a null. */
export const BAY_WRITE_SELECT = {
  status: true,
  invoice: { select: { status: true, _count: { select: { lines: true } } } },
} as const;

/** Shape a row from BAY_WRITE_SELECT into the predicate's input. */
export function bayWriteCard(row: {
  status: string;
  invoice?: { status: string; _count: { lines: number } } | null;
}): BayWriteCard {
  return {
    status: row.status,
    invoice: row.invoice ? { status: row.invoice.status, lineCount: row.invoice._count.lines } : null,
  };
}
