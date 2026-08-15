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
import { settlePaymentByRef, closePaymentByRef, reconcileInvoice } from '@/lib/payments';
import { invoiceTotals, balanceOwedPennies } from '@/lib/invoice';
import { writeAudit } from '@/lib/audit';
import { applyCardTransition } from '@/lib/jobcard-transition';
import type { JobStatus } from '@/lib/jobcard-status';

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

      // ── AND THE CARD MOVES WITH IT ────────────────────────────────────────────────────────
      // A paid invoice against a card still sitting at `invoiced` is an inconsistency the garage
      // sees on their own job list. Routed through the SHARED writer so the transition table
      // governs this move exactly as it governs the counter one — a webhook must not be a second,
      // ungoverned way to change a card's status. actorUserId is null: nobody at the garage did
      // this, the customer did, and the trail should say so.
      const card = await (tx as any).jobCard.findUnique({ where: { id: inv.job_card_id }, select: { status: true } });
      const moved = await applyCardTransition(tx, {
        groupId: inv.group_id, jobCardId: inv.job_card_id,
        from: card.status as JobStatus, to: 'paid', actorUserId: null,
      });
      // A REFUSAL IS NOT A FAILURE OF THE PAYMENT. The money arrived and the invoice says so; if the
      // card is somewhere the table will not move from (cancelled, already done), that is a fact
      // about the card, not about the payment, and rolling the transaction back would lose real
      // money over a spine inconsistency.
      if (!moved.ok) {
        console.warn('[fulfil] invoice', inv.invoice_number, 'paid but card stayed at', card.status, '—', moved.refusal.message);
      }
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

/**
 * MONEY GIVEN BACK. Writes a Refund row per Stripe refund, reconciles, and — the part that matters
 * commercially — RETURNS OUR APPLICATION FEE.
 *
 * ── THE GARAGE CANNOT REFUND OUR FEE, AND WOULD NOT KNOW ────────────────────────────────────────
 * Stripe is explicit: "An application fee can be refunded only by the application that created the
 * charge." So when a garage refunds a customer from their own Stripe dashboard — the obvious place
 * to do it — the money goes back and OUR CUT STAYS TAKEN. They are out of pocket by our fee on
 * money they have handed back, they cannot fix it themselves, and the only party who can is us.
 * That is why this runs automatically on the event rather than waiting to be asked.
 *
 * ── A REFUND DOES NOT REINSTATE A DEBT ──────────────────────────────────────────────────────────
 * The invoice status is deliberately NOT moved back. `expectedCachePennies` subtracts refunds, so a
 * fully refunded invoice's cache drops to zero and its BALANCE arithmetic reads as the whole total
 * owing again — which is false. The customer does not owe the money back; the transaction was
 * unwound. The document stays `paid`, the customer view reads status before balance and keeps
 * saying paid, offersPayLink refuses a non-issued invoice, and refusePayment refuses a paid one.
 * A garage that genuinely wants to re-bill voids and re-issues, which is an audited act.
 */
export async function recordCardRefunds(args: {
  charge: Stripe.Charge;
  accountId: string;
}): Promise<{ recorded: number; feeRefundedPennies: number | null }> {
  const list = args.charge.refunds?.data ?? [];
  if (args.charge.refunds?.has_more) {
    // Stripe pages this at 10. More than ten refunds on one garage invoice is not a real shape, but
    // silently processing the first ten would be a quiet undercount, so it is said out loud.
    console.warn('[fulfil] charge', args.charge.id, 'has more refunds than the event carried — reconcile manually');
  }

  const pay = await prisma.payment.findFirst({
    where: { OR: [{ charge_id: args.charge.id }, { payment_intent_id: typeof args.charge.payment_intent === 'string' ? args.charge.payment_intent : undefined }] },
    select: { id: true, group_id: true, invoice_id: true, amount_pennies: true, application_fee_pennies: true, application_fee_id: true },
  });
  if (!pay) return { recorded: 0, feeRefundedPennies: null };

  // ── THE MONEY FACT FIRST ──────────────────────────────────────────────────────────────────
  let recorded = 0;
  for (const r of list) {
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await (tx as any).refund.create({
          data: {
            group_id: pay.group_id, payment_id: pay.id,
            amount_pennies: r.amount, currency: (r.currency ?? 'gbp').toUpperCase(),
            reason: r.reason ?? null, refund_id: r.id, source_ref: r.id,
          },
        });
        await reconcileInvoice(tx, pay.invoice_id);
      });
      recorded++;
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e; // already recorded — a redelivery, not a problem
    }
  }

  // ── THEN OUR FEE, SEPARATELY, BECAUSE IT CAN FAIL ─────────────────────────────────────────
  const feeRefunded = await refundApplicationFee(pay, args.charge);
  if (feeRefunded != null) {
    await prisma.refund.updateMany({
      where: { payment_id: pay.id, application_fee_refunded_pennies: null },
      data: { application_fee_refunded_pennies: feeRefunded },
    });
  }
  return { recorded, feeRefundedPennies: feeRefunded };
}

/**
 * Give back our cut, in proportion to what was returned to the customer. Platform-level call — no
 * `stripeAccount` header — because we are the application that took the fee and the only party
 * Stripe permits to return it.
 *
 * Returns NULL when it could not be done, which stays on the Refund row as unknown rather than as
 * zero. Zero would be a claim that we deliberately kept it.
 */
async function refundApplicationFee(
  pay: { application_fee_id: string | null; application_fee_pennies: number | null; amount_pennies: number },
  charge: Stripe.Charge,
): Promise<number | null> {
  const stripe = getStripe();
  if (!stripe || !pay.application_fee_id || !pay.application_fee_pennies) return null;
  // Proportional to the share of the charge returned. A full refund returns the whole fee; floor
  // again, so rounding never favours us on the way back either.
  const share = Math.min(charge.amount_refunded / (pay.amount_pennies || charge.amount || 1), 1);
  const amount = Math.floor(pay.application_fee_pennies * share);
  if (amount <= 0) return 0;
  try {
    const fr = await stripe.applicationFees.createRefund(pay.application_fee_id, { amount });
    return fr.amount;
  } catch (e: any) {
    // Loud. This is the garage being out of pocket by our fee, and nobody would otherwise see it.
    console.error('[fulfil] APPLICATION FEE NOT RETURNED for', charge.id, '—', e?.message);
    return null;
  }
}

/** A card attempt that ended without money. Terminal, and it frees the invoice of a pending row. */
export async function closeCardPayment(paymentIntentId: string, status: 'failed' | 'canceled'): Promise<boolean> {
  const r = await prisma.$transaction(async (tx: Prisma.TransactionClient) => closePaymentByRef(tx, paymentIntentId, status));
  return r.closed;
}
