/**
 * File: lib/no-charge.ts
 * CLOSING A JOB CARD WITHOUT BILLING IT — the rules, in one place.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Some cards exist only to direct a mechanic and hold intake: a comeback, a courtesy car, an
 * inspection that did not convert. Until this shipped the only way to FINISH a card was to invoice
 * it, so TMBS spent chargeable invoice number 100003331 on a £0 document with no lines — a number
 * out of a gapless statutory series, consumed to close a card nobody was going to bill.
 *
 * Everything here is a REFUSAL rather than a default. A closure with no reason, or with a reason
 * this system does not know, or over an invoice that already exists, is turned away — because the
 * whole point of the grain is to count it later, and a defaulted reason counts as a decision
 * nobody made.
 */
import type { JobStatus } from '@/lib/jobcard-status';

/**
 * THE REASONS, AS KEYS. Never English in the column: these are counted, translated and will be
 * renamed, and a display string makes all three a migration. The i18n labels live in the locale
 * files under `jobcard.noCharge.reason.*`.
 */
export const NO_CHARGE_REASONS = [
  'comeback_rework',
  'warranty',
  'goodwill',
  /** The garage's own vehicle, a courtesy car, car-sales prep — its own cost, not a gift. */
  'internal',
  'inspection_only',
  /**
   * THE ONE WITH A CONVERSION RATE. Inspection, findings and quote live on ONE card: accepted, the
   * work continues here and is invoiced with the inspection time included; declined, the card
   * closes under this reason. There is no inspection fee — free is free — so this key is the only
   * record that the inspection cost anything at all.
   */
  'inspection_for_quote',
] as const;
export type NoChargeReason = (typeof NO_CHARGE_REASONS)[number];

export const isNoChargeReason = (v: unknown): v is NoChargeReason =>
  typeof v === 'string' && (NO_CHARGE_REASONS as readonly string[]).includes(v);

export type NoChargeRefusal = { code: string; message: string };

/**
 * May this card be closed as no charge, and with this reason?
 *
 * ── ANY INVOICE, VOIDED INCLUDED ───────────────────────────────────────────────────────────────
 * Owner's ruling, 2026-10-24. A void RETIRES the number and RETAINS the document (VATREC5010), so
 * a card whose invoice was voided is NOT an uninvoiced card — and it is exactly the one somebody
 * will try to close as no-charge to tidy up, which would make the void look like it never
 * happened. The refusal NAMES the number, because "this card has been invoiced" sends the reader
 * looking for an invoice the Invoices list may no longer show them.
 */
export function refuseNoCharge(args: {
  status: JobStatus | string;
  reason?: unknown;
  /** The invoice on this card, if there is one in ANY state. */
  invoice?: { invoice_number: string; status: string } | null;
  /** Re-derived server-side from role + tenant toggle — never a client claim. */
  permitted: boolean;
}): NoChargeRefusal | null {
  if (!args.permitted) {
    return { code: 'not_permitted', message: 'You do not have permission to close a job card without charging for it.' };
  }
  if (args.invoice) {
    return {
      code: 'already_invoiced',
      message: `This card has invoice ${args.invoice.invoice_number}${args.invoice.status === 'void' ? ' (voided)' : ''}, so it cannot be closed as no charge. A voided invoice is retired, not undone — the document is still on the books.`,
    };
  }
  if (args.status === 'no_charge') {
    return { code: 'already_no_charge', message: 'This card is already closed as no charge.' };
  }
  if (args.reason === undefined || args.reason === null || args.reason === '') {
    return { code: 'reason_required', message: 'Choose a reason. It is what lets you count comebacks, warranty work and free inspections later.' };
  }
  if (!isNoChargeReason(args.reason)) {
    return { code: 'reason_unknown', message: `“${String(args.reason)}” is not one of the no-charge reasons.` };
  }
  return null;
}

/** May this no-charge card be reopened, and to what? */
export function refuseReopen(args: {
  status: JobStatus | string;
  priorStatus?: JobStatus | string | null;
  permitted: boolean;
}): NoChargeRefusal | null {
  if (!args.permitted) {
    return { code: 'not_permitted', message: 'You do not have permission to reopen a card closed as no charge.' };
  }
  if (args.status !== 'no_charge') {
    return { code: 'not_no_charge', message: 'This card is not closed as no charge.' };
  }
  if (!args.priorStatus) {
    // A card closed before this column existed, or one whose prior status was lost. REFUSING is
    // right: guessing `in_progress` would silently reopen a declined card into live work.
    return { code: 'no_prior_status', message: 'This card does not record what it was before it was closed, so it cannot be reopened automatically. Set the status directly.' };
  }
  return null;
}

/**
 * The reason to OFFER, never the reason to apply.
 *
 * A declined card is the inspection-for-quote case by construction: the quote went out and came
 * back no. Every other card gets NULL rather than a guess — a reason pre-filled on every card is
 * a reason nobody chose, and these are the numbers the free-inspection report will be built from.
 */
export function suggestedReason(card: { status: JobStatus | string }): NoChargeReason | null {
  return card.status === 'declined' ? 'inspection_for_quote' : null;
}
