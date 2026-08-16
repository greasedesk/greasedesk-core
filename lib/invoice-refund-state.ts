/**
 * File: lib/invoice-refund-state.ts
 * WHETHER MONEY WENT BACK, AND HOW MUCH. One rule, read by every surface that shows an invoice.
 *
 * ── DERIVED, NOT A NEW STATUS ───────────────────────────────────────────────────────────────────
 * There is deliberately no `refunded` value on InvoiceStatus. Two reasons, and the second is the
 * one that decides it:
 *
 *  1. The ledger already knows. Refund rows exist; the answer is arithmetic over them, exactly as
 *     the balance is. A stored status would be a second opinion that drifts the first time a
 *     refund lands without the status writer running — which is precisely the failure that left
 *     invoice 100003210 claiming to be paid while the money sat back in the customer's account.
 *
 *  2. `paid` IS STILL TRUE. The document was paid. Money was afterwards returned. Those are two
 *     facts, not a correction of the first, and collapsing them loses the one a VAT return needs:
 *     the invoice was settled on its date_paid. refusePayment already works this way — it checks
 *     document status BEFORE balance, so a refund cannot reopen a debt — and this completes the
 *     thought rather than contradicting it.
 *
 * A REFUND IS NOT A RETURN TO `issued`. An unpaid invoice is money owed; a refunded one is money
 * that came and went. Rendering the first as the second would put a Pay button in front of somebody
 * who has already been made whole.
 *
 * ── PARTIALS ARE THE COMMON CASE, NOT THE EDGE ──────────────────────────────────────────────────
 * A customer disputes one line of four and the garage returns that line. The document stays paid,
 * part of the money is back, and there is a real balance the garage may or may not chase. The
 * amounts are stated; what to do about them is a decision, not a derivation.
 */

export type RefundState =
  | { kind: 'none'; refundedPennies: 0; at: null }
  | { kind: 'partial'; refundedPennies: number; at: Date | null; receivedPennies: number }
  | { kind: 'full'; refundedPennies: number; at: Date | null; receivedPennies: number };

export type RefundRowLike = { amount_pennies: number; created_at: Date | string };

/**
 * `receivedPennies` is the GROSS ever received — Σ succeeded payments, before refunds are taken
 * off. Not the cached balance: that figure is already net of refunds, so comparing refunds against
 * it would call every full refund a partial one.
 */
export function refundState(args: {
  receivedPennies: number;
  refunds: RefundRowLike[];
}): RefundState {
  const rows = args.refunds ?? [];
  const refundedPennies = rows.reduce((a, r) => a + (r.amount_pennies ?? 0), 0);
  if (refundedPennies <= 0) return { kind: 'none', refundedPennies: 0, at: null };

  // The LATEST refund is the date the customer cares about — "when did I get my money back" means
  // the last of it, not the first instalment of it.
  const at = rows
    .map((r) => new Date(r.created_at))
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  // `>=` not `===`: an over-refund (a goodwill top-up processed as a refund) is still fully
  // refunded, and treating it as partial would tell the customer money is outstanding when more
  // than all of it has come back.
  const kind = args.receivedPennies > 0 && refundedPennies >= args.receivedPennies ? 'full' : 'partial';
  return { kind, refundedPennies, at, receivedPennies: args.receivedPennies };
}

/** Does this document need to say anything about a refund at all? */
export const hasRefund = (s: RefundState): boolean => s.kind !== 'none';
