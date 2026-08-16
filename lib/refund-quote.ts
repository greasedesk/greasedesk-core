/**
 * File: lib/refund-quote.ts
 * WHAT A REFUND ACTUALLY COSTS THE GARAGE, in their terms rather than Stripe's.
 *
 * ── THE FEE THAT DOES NOT COME BACK ─────────────────────────────────────────────────────────────
 * Stripe keeps its processing fee on a refund. It has done since 2019 and it applies whatever the
 * refund size — refund £5 of a £50 payment and the whole 95p is still gone. Our application fee DOES
 * come back, proportionally, because we return it (lib/card-payment-fulfil::settleApplicationFeeRefund).
 *
 * So a garage owner pressing Refund on a fully-paid £50 invoice ends up 95p DOWN, and nothing on
 * screen has ever said so. That is a fact they should meet in the dialog, not discover on a
 * statement three days later, and it is the whole reason this file exists rather than the button
 * just showing an amount box.
 *
 * ── PURE, SO THE DIALOG AND THE GATE READ ONE RULE ──────────────────────────────────────────────
 * No Stripe call, no database. The figures the confirmation shows are the figures the gate asserts.
 */

export type RefundQuote = {
  /** Pennies going back to the customer. */
  refundPennies: number;
  /** Our application fee returned with it — proportional, floored, never rounding our way. */
  ourFeeReturnedPennies: number;
  /** Stripe's processing fee. NEVER returned. Stated because it is the surprise. */
  stripeFeeKeptPennies: number | null;
  /**
   * What the garage is left holding from this payment once the refund settles. NEGATIVE means they
   * are out of pocket — which is the normal outcome of a full refund, and the number that matters.
   */
  retainedPennies: number | null;
  /** True when the refund empties the payment. */
  isFull: boolean;
};

export type RefundRefusal = { code: string; message: string };

/**
 * Can this amount be refunded, and what does it mean?
 *
 * `alreadyRefundedPennies` is the sum of refunds already recorded against the payment, so a second
 * partial cannot take the total past what was collected.
 */
export function quoteRefund(args: {
  amountPennies: number;
  refundPennies: number;
  alreadyRefundedPennies: number;
  applicationFeePennies: number | null;
  /** NULL means we never learned it — say so rather than implying the refund is free. */
  stripeFeePennies: number | null;
  applicationFeeAlreadyReturnedPennies: number;
}): { ok: true; quote: RefundQuote } | { ok: false; refusal: RefundRefusal } {
  const { amountPennies, refundPennies, alreadyRefundedPennies } = args;

  if (!Number.isInteger(refundPennies) || refundPennies <= 0) {
    return { ok: false, refusal: { code: 'bad_amount', message: 'Enter an amount to refund.' } };
  }
  const remaining = amountPennies - alreadyRefundedPennies;
  if (remaining <= 0) {
    return { ok: false, refusal: { code: 'nothing_left', message: 'This payment has already been refunded in full.' } };
  }
  if (refundPennies > remaining) {
    return {
      ok: false,
      refusal: {
        code: 'exceeds_remaining',
        // The figure, not just the rule — a garage owner needs to know what they CAN refund.
        message: `You can refund up to ${penceToPounds(remaining)} on this payment.`,
      },
    };
  }

  // OUR FEE, proportional to the whole payment and net of anything already returned. Floored, so
  // rounding never favours us on the way back — the same rule the reversal itself applies.
  const fee = args.applicationFeePennies ?? 0;
  const totalRefundedAfter = alreadyRefundedPennies + refundPennies;
  const feeTargetAfter = amountPennies > 0 ? Math.floor((fee * totalRefundedAfter) / amountPennies) : 0;
  const ourFeeReturnedPennies = Math.max(0, feeTargetAfter - args.applicationFeeAlreadyReturnedPennies);

  // STRIPE'S FEE IS NOT PRO-RATED AND NOT RETURNED. Honest-null: if we never learned it (enrichment
  // did not run) we say we do not know rather than implying nothing is lost.
  const stripeFeeKeptPennies = args.stripeFeePennies;
  const retainedPennies = stripeFeeKeptPennies === null
    ? null
    : amountPennies - stripeFeeKeptPennies - (fee - (args.applicationFeeAlreadyReturnedPennies + ourFeeReturnedPennies)) - totalRefundedAfter;

  return {
    ok: true,
    quote: {
      refundPennies,
      ourFeeReturnedPennies,
      stripeFeeKeptPennies,
      retainedPennies,
      isFull: totalRefundedAfter >= amountPennies,
    },
  };
}

const penceToPounds = (p: number) => `£${(p / 100).toFixed(2)}`;

/**
 * The sentences the confirmation shows. Here rather than in the component so the gate asserts the
 * words a garage owner actually reads — the cost warning is the point of the dialog, and a warning
 * that lives only in JSX is one nobody can test.
 */
export function refundConfirmationLines(q: RefundQuote): string[] {
  const lines = [`${penceToPounds(q.refundPennies)} goes back to the customer.`];

  if (q.ourFeeReturnedPennies > 0) {
    lines.push(`Our ${penceToPounds(q.ourFeeReturnedPennies)} fee on that is returned to you.`);
  }

  if (q.stripeFeeKeptPennies === null) {
    // Unknown, said as unknown. "No fee" would be a claim.
    lines.push('Stripe’s processing fee on the original payment is not returned. We don’t have the exact figure for this payment — check Stripe for it.');
  } else if (q.stripeFeeKeptPennies > 0) {
    lines.push(`Stripe keeps its ${penceToPounds(q.stripeFeeKeptPennies)} processing fee — that is not returned, whatever you refund.`);
  }

  if (q.retainedPennies !== null) {
    lines.push(q.retainedPennies < 0
      // The blunt one. A full refund leaves them down by Stripe's fee and they should read it here.
      ? `You’ll be ${penceToPounds(-q.retainedPennies)} out of pocket on this payment.`
      : `You’ll keep ${penceToPounds(q.retainedPennies)} from this payment.`);
  }
  return lines;
}
