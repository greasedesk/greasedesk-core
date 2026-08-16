/**
 * File: lib/refund-eligibility.ts
 * WHAT CAN BE REFUNDED, and when it cannot, WHY. One predicate, read by the surface and by both
 * endpoints — so a control that appears is a control that works.
 *
 * That rule is not abstract here. The Pay button shipped once with the page deciding one way and
 * the endpoint another, and a customer saw "Pay" next to "card payment isn't available for this
 * invoice" at the same time. The fix was to share the predicate, and this is that fix applied
 * before the same mistake rather than after it.
 *
 * ── TWO ORIGINS, ONE ELIGIBILITY QUESTION ───────────────────────────────────────────────────────
 * A card payment is refunded by asking Stripe (pages/api/payments/refund) and the webhook writes
 * the ledger. A manual payment — cash from the till, a bank transfer, the card machine on the
 * counter — has no external system to ask and no webhook to answer, so its endpoint writes the
 * ledger itself (pages/api/payments/manual-refund). That is not a departure from "the button must
 * not write the ledger": that rule exists because Stripe refunds arrive from three directions and a
 * fourth writer would disagree with the other three. A till has one direction, and the person at
 * the counter is the only witness there is.
 *
 * What the two share is this file: what is left on a payment, and the refusal when nothing is.
 */

/** A refusal a person can act on, not a code a developer can grep. */
export type RefundRefusal = { code: string; message: string };

export type PaymentForRefund = {
  id: string;
  provider: string;              // 'stripe' | 'manual'
  status: string;                // 'succeeded' | 'processing' | 'failed'
  amount_pennies: number;
  currency: string;
  collected_at: Date;
  payment_method_snapshot: string | null;
  refunds: Array<{ amount_pennies: number }>;
};

export type RefundableLine = {
  paymentId: string;
  /** 'card' asks Stripe; 'manual' records what the garage handed back. */
  origin: 'card' | 'manual';
  receivedPennies: number;
  alreadyRefundedPennies: number;
  remainingPennies: number;
  currency: string;
  collectedAt: Date;
  methodLabel: string | null;
  /** Null when this payment can be refunded. Otherwise the reason, in words. */
  refusal: RefundRefusal | null;
};

/**
 * Per-payment eligibility. Pure — no database, no Stripe — so the gate can prove every refusal
 * without constructing money.
 *
 * A payment is refundable when it SETTLED and something is left on it. Everything else is a
 * refusal with its own sentence, because "you cannot refund this" for three different reasons is
 * three different things for the garage to do next.
 */
export function refundableForPayment(p: PaymentForRefund): RefundableLine {
  const already = p.refunds.reduce((a, r) => a + (r.amount_pennies ?? 0), 0);
  const remaining = Math.max(0, p.amount_pennies - already);
  const origin: 'card' | 'manual' = p.provider === 'stripe' ? 'card' : 'manual';
  const base = {
    paymentId: p.id, origin,
    receivedPennies: p.amount_pennies,
    alreadyRefundedPennies: already,
    remainingPennies: remaining,
    currency: p.currency,
    collectedAt: p.collected_at,
    methodLabel: p.payment_method_snapshot,
  };

  if (p.status !== 'succeeded') {
    return {
      ...base,
      refusal: {
        code: 'not_settled',
        message: 'This payment hasn’t cleared yet, so there’s nothing to send back. It will either clear or fail shortly.',
      },
    };
  }
  if (remaining <= 0) {
    return {
      ...base,
      refusal: {
        code: 'fully_refunded',
        message: 'This payment has already been refunded in full.',
      },
    };
  }
  return { ...base, refusal: null };
}

/**
 * The whole invoice's refund position. `refusals` carries the payments that cannot be refunded AND
 * WHY, rather than dropping them — a garage looking at a paid invoice with no refund control needs
 * to be told why, not left to conclude the feature is broken.
 */
export type RefundPosition = {
  lines: RefundableLine[];
  refundable: RefundableLine[];
  totalRemainingPennies: number;
  /** Set when the INVOICE itself forbids refunds, whatever its payments say. */
  invoiceRefusal: RefundRefusal | null;
};

export function refundPosition(
  payments: PaymentForRefund[],
  invoice: { status: string } | null,
  /** From lib/invoice-void::refuseIfVoid — passed in rather than imported, to keep this pure. */
  voidRefusal: RefundRefusal | null,
): RefundPosition {
  const lines = payments.map(refundableForPayment);
  // A VOID invoice retains its document and its history, and refuses every money movement. The
  // same refusal the eight other paths get — one rule, not a ninth opinion.
  const invoiceRefusal = voidRefusal
    ?? (invoice ? null : { code: 'no_invoice', message: 'Nothing has been invoiced on this job yet, so no money has been taken to send back.' });
  return {
    lines,
    refundable: invoiceRefusal ? [] : lines.filter((l) => l.refusal === null),
    totalRemainingPennies: invoiceRefusal ? 0 : lines.filter((l) => !l.refusal).reduce((a, l) => a + l.remainingPennies, 0),
    invoiceRefusal,
  };
}

/**
 * THE CAP, as its own function because it is the one number a manual refund can get wrong in a way
 * that costs money. You cannot hand back more than came in — not across one payment, and not by
 * salami-slicing several partials past the total.
 */
export function refuseManualAmount(line: RefundableLine, amountPennies: number): RefundRefusal | null {
  if (!Number.isInteger(amountPennies) || amountPennies <= 0) {
    return { code: 'bad_amount', message: 'Enter how much you handed back, as an amount greater than zero.' };
  }
  if (line.refusal) return line.refusal;
  if (amountPennies > line.remainingPennies) {
    return {
      code: 'exceeds_remaining',
      message: `That’s more than is left on this payment. At most ${(line.remainingPennies / 100).toFixed(2)} can still be returned.`,
    };
  }
  return null;
}
