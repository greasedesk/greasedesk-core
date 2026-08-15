/**
 * File: lib/card-payment-fulfil.ts
 * FULFILMENT: a customer's card payment actually arrived, so the ledger and the document say so.
 *
 * Called only by the Connect webhook. The browser returning from a card form proves nothing — it
 * can be closed, refreshed or replayed, and 3-D Secure can complete after the tab has gone — so
 * `payment_intent.succeeded` is the single event that turns an intent into money here.
 *
 * ── SHAPED ON lib/confirm-paid, WHICH SOLVES THE SAME PROBLEM ───────────────────────────────────
 * Claim-first idempotency inside a transaction, then the receipt AFTER it. Stripe retries, and a
 * confirmation that can double-send is a customer receiving two receipts for one payment.
 *
 * ── THE MONEY IS COMMITTED BEFORE ANYTHING SECONDARY ────────────────────────────────────────────
 * The standing rule (financial-write-first): the ledger write and the invoice flip happen in one
 * transaction, and only then does anything else run. Enriching the row with Stripe's charge and fee
 * detail needs a second API call, which can fail — and a failed enrichment must never cost us the
 * record that the money arrived. Fees are nice to have; the payment is the fact.
 *
 * ── A PAYMENT WE DID NOT START IS NOT AN ERROR ──────────────────────────────────────────────────
 * The garage's Stripe account is theirs. They can take a payment on a Terminal, from their own
 * dashboard, or through another product entirely, and every one of those emits
 * `payment_intent.succeeded` to this endpoint. There is no Payment row for those and there must not
 * be: we do not know which invoice, or whether there is one. Recorded in the log and ignored.
 */
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getStripe } from '@/lib/stripe';
import { settlePaymentByRef, closePaymentByRef } from '@/lib/payments';
import { invoiceTotals, balanceOwedPennies } from '@/lib/invoice';
import { writeAudit } from '@/lib/audit';

/** What the garage sees as the method on a document. Not a tenant PaymentMethod row — those are
 *  theirs to define, and inventing one on their behalf would put a row in their settings. */
export const CARD_METHOD_LABEL = 'Card (online)';

export type FulfilResult =
  | { outcome: 'not_ours'; paymentIntentId: string }
  | { outcome: 'already_done'; invoiceId: string }
  | { outcome: 'settled'; invoiceId: string; groupId: string; fullyPaid: boolean };

/**
 * Turn a succeeded PaymentIntent into money. Returns what happened so the caller can decide whether
 * to send a receipt — deliberately NOT sending one itself, because the send must happen outside the
 * transaction and the caller owns that boundary.
 */
export async function fulfilCardPayment(args: {
  paymentIntentId: string;
  at?: Date;
}): Promise<FulfilResult> {
  const at = args.at ?? new Date();

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const settle = await settlePaymentByRef(tx, args.paymentIntentId, at);
    if (!settle.found) return { outcome: 'not_ours', paymentIntentId: args.paymentIntentId };

    const inv = (await (tx as any).invoice.findUnique({
      where: { id: settle.invoiceId! },
      select: {
        id: true, group_id: true, job_card_id: true, invoice_number: true, status: true,
        amount_paid_pennies: true, vat_registered_at_issue: true, paid_at: true,
        lines: { select: { vat_rate: true, line_total: true, line_vat: true } },
      },
    })) as any;

    if (!settle.settled) {
      // A redelivery. The cache was recomputed above, so there is nothing left to do and — crucially
      // — no second receipt.
      return { outcome: 'already_done', invoiceId: inv.id };
    }

    // Is the document now settled? Recomputed from the frozen lines and the reconciled cache, not
    // assumed from "the payment we expected has landed": the garage may have taken part of it in
    // cash while the card was in flight, and a part payment must leave the invoice open.
    const totals = invoiceTotals(inv.lines);
    const totalPennies = inv.vat_registered_at_issue ? totals.grossPennies : totals.netPennies;
    const fullyPaid = balanceOwedPennies(inv, totalPennies) <= 0;

    if (fullyPaid && inv.status === 'issued') {
      await (tx as any).invoice.update({
        where: { id: inv.id },
        data: {
          status: 'paid',
          paid_at: at,
          // The DOCUMENT date is the day the money arrived. Not overwritten if one already exists —
          // a card payment completing an invoice that was part-settled earlier must not move the
          // earlier date into a different VAT quarter.
          date_paid: inv.paid_at ? undefined : at,
          confirm_due_at: null,
          payment_method_snapshot: CARD_METHOD_LABEL,
        },
      });
      // Two rows, matching the instant-clearance path in jobcard-status: the money arrived AND it
      // is confirmed. A card payment has no clearance window — it is in the account or it is not.
      await writeAudit(tx, {
        groupId: inv.group_id, userId: null, jobCardId: inv.job_card_id, action: 'invoice.paid',
        diff: { number: inv.invoice_number, method: CARD_METHOD_LABEL, clearance: 'instant', online: true },
      });
      await writeAudit(tx, {
        groupId: inv.group_id, userId: null, jobCardId: inv.job_card_id, action: 'invoice.paid_confirmed',
        diff: { number: inv.invoice_number, method: CARD_METHOD_LABEL, online: true },
      });
    } else if (!fullyPaid) {
      // Part payment. The ledger records it; the document stays open and says what is left.
      await writeAudit(tx, {
        groupId: inv.group_id, userId: null, jobCardId: inv.job_card_id, action: 'invoice.part_paid',
        diff: { number: inv.invoice_number, method: CARD_METHOD_LABEL, receivedPennies: settle.amountPennies, online: true },
      });
    }

    return { outcome: 'settled', invoiceId: inv.id, groupId: inv.group_id, fullyPaid };
  });
}

/**
 * Best-effort enrichment: what Stripe actually charged, and what it kept. Runs AFTER fulfilment and
 * never inside it — a failure here must cost us fee detail, never the record of the payment.
 *
 * `stripe_fee_pennies` is the GARAGE's processing fee, read from the balance transaction on their
 * own account. It stays NULL when we could not read it, which is honest: unknown, not zero.
 */
export async function enrichCardPayment(args: {
  paymentIntent: Stripe.PaymentIntent;
  accountId: string;
}): Promise<void> {
  const stripe = getStripe();
  if (!stripe) return;
  const chargeId = typeof args.paymentIntent.latest_charge === 'string'
    ? args.paymentIntent.latest_charge
    : args.paymentIntent.latest_charge?.id;
  if (!chargeId) return;

  try {
    const charge = await stripe.charges.retrieve(
      chargeId,
      { expand: ['balance_transaction', 'application_fee'] },
      { stripeAccount: args.accountId },
    );
    const bt = charge.balance_transaction;
    const fee = charge.application_fee;
    await prisma.payment.updateMany({
      where: { source_ref: args.paymentIntent.id },
      data: {
        charge_id: chargeId,
        stripe_fee_pennies: bt && typeof bt !== 'string' ? bt.fee : undefined,
        application_fee_id: fee ? (typeof fee === 'string' ? fee : fee.id) : undefined,
      },
    });
  } catch (e: any) {
    // Deliberately swallowed, loudly. The payment is already recorded and reconciled; this is
    // detail for a margin view that does not exist yet.
    console.error('[fulfil] fee enrichment failed for', args.paymentIntent.id, e?.message);
  }
}

/** A card attempt that ended without money. Terminal, and it frees the invoice of a pending row. */
export async function closeCardPayment(paymentIntentId: string, status: 'failed' | 'canceled'): Promise<boolean> {
  const r = await prisma.$transaction(async (tx: Prisma.TransactionClient) => closePaymentByRef(tx, paymentIntentId, status));
  return r.closed;
}
