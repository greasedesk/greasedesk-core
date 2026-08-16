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
import { listChargeRefunds, refundCounts, StripeReadError, type RefundLite } from '@/lib/stripe-refunds';
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

  // The callback's return type is ANNOTATED. Without it TypeScript widens `outcome: 'not_ours'` to
  // `string` and the discriminated union stops discriminating — the callers switch on `outcome`, so
  // losing the literal types loses the exhaustiveness that makes that switch safe.
  return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<FulfilResult> => {
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
  chargeId: string;
  accountId: string;
}): Promise<{ recorded: number; alreadyHad: number; feeRefundedPennies: number | null }> {
  const stripe = getStripe();
  if (!stripe) throw new StripeReadError(`cannot reconcile refunds for ${args.chargeId}: no Stripe client`);

  // ── ASK STRIPE, DO NOT READ THE EVENT ──────────────────────────────────────────────────────
  // Both the charge and the refunds are retrieved. The event body told us WHICH charge to look at
  // and nothing more — that is all a notification is good for. `charge.refunds` was the field that
  // silently returned nothing for every refund ever processed; see lib/stripe-refunds.
  const charge = await stripe.charges.retrieve(args.chargeId, {}, { stripeAccount: args.accountId });
  const refunds = (await listChargeRefunds(args.chargeId, { accountId: args.accountId })).filter(refundCounts);

  const pay = await prisma.payment.findFirst({
    where: { OR: [{ charge_id: args.chargeId }, { payment_intent_id: typeof charge.payment_intent === 'string' ? charge.payment_intent : undefined }] },
    select: { id: true, group_id: true, invoice_id: true, amount_pennies: true, application_fee_pennies: true, application_fee_id: true },
  });
  // Not ours. A Terminal sale or a dashboard charge on the garage's own account — we have no row and
  // must not invent one. Distinct from "we failed": recorded 0 with nothing attempted.
  if (!pay) return { recorded: 0, alreadyHad: 0, feeRefundedPennies: null };

  // Backfill the charge id the first time we see it, so the next lookup is direct.
  if (!(await prisma.payment.count({ where: { id: pay.id, charge_id: args.chargeId } }))) {
    await prisma.payment.updateMany({ where: { id: pay.id }, data: { charge_id: args.chargeId } });
  }

  // ── THE MONEY FACT FIRST ──────────────────────────────────────────────────────────────────
  // Keyed on the Stripe refund id, so `charge.refunded` and `refund.created` describing the SAME
  // refund write it once. Both triggers reconcile the whole charge rather than carrying a refund
  // between them — that is what makes the collision a no-op instead of a race.
  let recorded = 0, alreadyHad = 0;
  for (const r of refunds) {
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await (tx as any).refund.create({
          data: {
            group_id: pay.group_id, payment_id: pay.id,
            amount_pennies: r.amount, currency: r.currency,
            reason: r.reason, refund_id: r.id, source_ref: r.id,
            // STRIPE'S OWN TIMESTAMP, not when this webhook landed. They are usually seconds apart
            // and were indistinguishable while this was the only path — but a re-sent event, a
            // retried delivery or a manual repair can arrive hours or days later, and the money
            // moved when Stripe says it moved. (Today's £50 was recorded 90 minutes after the fact
            // for exactly that reason.)
            collected_at: r.created,
          },
        });
        await reconcileInvoice(tx, pay.invoice_id);
      });
      recorded++;
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e; // already recorded — a redelivery, not a problem
      alreadyHad++;
    }
  }

  // ── THEN OUR FEE, SEPARATELY, BECAUSE IT CAN FAIL ─────────────────────────────────────────
  const feeRefunded = await settleApplicationFeeRefund(pay, charge, refunds);
  return { recorded, alreadyHad, feeRefundedPennies: feeRefunded };
}

/**
 * Give back our cut, in proportion to what was returned to the customer. Platform-level call — no
 * `stripeAccount` header — because we are the application that took the fee and the only party
 * Stripe permits to return it.
 *
 * Returns NULL when it could not be done, which stays on the Refund row as unknown rather than as
 * zero. Zero would be a claim that we deliberately kept it.
 */
async function settleApplicationFeeRefund(
  pay: { id: string; application_fee_id: string | null; application_fee_pennies: number | null; amount_pennies: number },
  charge: Stripe.Charge,
  refunds: RefundLite[],
): Promise<number | null> {
  const stripe = getStripe();
  if (!stripe || !pay.application_fee_pennies) return null;

  // ── THE FEE ID COMES FROM THE CHARGE, NOT FROM OUR COLUMN ────────────────────────────────
  // It used to require Payment.application_fee_id, which is written by enrichCardPayment AFTER
  // fulfilment. So a refund on a payment whose enrichment had not run returned early and silently
  // kept our fee while the garage returned the customer's money in full. On 16 Aug 2026 that path
  // only worked because the column had been set by hand an hour earlier.
  // `charge.application_fee` is an ID STRING in the body and on retrieval — one of the fields that
  // IS dependable. The stored column is the fallback, not the source.
  const feeId = (typeof charge.application_fee === 'string' ? charge.application_fee : charge.application_fee?.id)
    ?? pay.application_fee_id;
  if (!feeId) {
    console.error('[fulfil] no application fee id for charge', charge.id, '— our fee cannot be returned');
    return null;
  }

  // ── TWO QUESTIONS, NOT ONE ────────────────────────────────────────────────────────────────
  //   (a) does money need to move?          — conditional
  //   (b) is our record of it accurate?     — never conditional
  //
  // These used to be answered together, and (b) rode on (a): when the delta came out at zero the
  // function returned before it stamped anything. So a fee returned OUT OF BAND — the garage owner
  // clicking refund on the fee in Stripe's own dashboard — left the column NULL for ever, because
  // the only code that could have written it had correctly decided there was nothing to move. And a
  // second partial refund could never backfill the first partial's missing stamp for the same
  // reason. NULL means unknown; that value was merely un-witnessed, which is not the same thing.
  //
  // STRIPE IS THE AUTHORITY ON WHAT HAS BEEN RETURNED, not our own rows. Reading fee.amount_refunded
  // rather than summing what we happen to have recorded is what lets an out-of-band reversal be
  // discovered instead of inferred away.
  const share = Math.min((charge.amount_refunded ?? 0) / (pay.amount_pennies || charge.amount || 1), 1);
  const target = Math.floor(pay.application_fee_pennies * share);

  let returnedAtStripe: number | null = null;
  try {
    const fee = await stripe.applicationFees.retrieve(feeId);
    returnedAtStripe = fee.amount_refunded ?? 0;
  } catch (e: any) {
    // Fall back to our own sum. Worse — it cannot see an out-of-band reversal — but it keeps the
    // money decision safe: we will never refund MORE than the target because the target caps it.
    console.error('[fulfil] could not read application fee', feeId, '—', e?.message);
  }
  const recordedSum = (await prisma.refund.aggregate({
    where: { payment_id: pay.id }, _sum: { application_fee_refunded_pennies: true },
  }))._sum.application_fee_refunded_pennies ?? 0;
  let actuallyReturned = returnedAtStripe ?? recordedSum;

  // ── (a) MOVE MONEY, ONLY IF THERE IS A GAP ────────────────────────────────────────────────
  // createRefund is not idempotent on its own, so the guard is what Stripe says is already back.
  const delta = target - actuallyReturned;
  if (delta > 0) {
    try {
      const fr = await stripe.applicationFees.createRefund(
        feeId,
        { amount: delta },
        // Belt to the arithmetic's braces: the same charge at the same refunded total never moves
        // the fee twice even if two events arrive at once.
        { idempotencyKey: `fee-refund:${charge.id}:${charge.amount_refunded ?? 0}` },
      );
      actuallyReturned += fr.amount ?? 0;
    } catch (e: any) {
      // Loud. This is the garage being out of pocket by our fee, and nobody would otherwise see it.
      console.error('[fulfil] APPLICATION FEE NOT RETURNED for', charge.id, '—', e?.message);
      // NOT a return: the record below is still worth correcting to whatever IS back, and stopping
      // here is what produced the stale NULLs in the first place.
    }
  }

  // ── (b) MAKE THE RECORD MATCH, WHETHER OR NOT ANYTHING MOVED ──────────────────────────────
  // Distributed across the refund rows in proportion to their amounts so every row carries a
  // defensible figure and the SUM equals what Stripe actually returned. The remainder goes to the
  // newest row, so pennies are never lost to flooring.
  await stampFeeRefunds(pay.id, refunds, actuallyReturned);
  return actuallyReturned;
}

/**
 * HOW A RETURNED FEE IS ATTRIBUTED ACROSS REFUND ROWS. Pure, and EXPORTED so the gate asserts this
 * rule rather than a copy of it — a gate that reimplements the arithmetic it is checking proves the
 * two implementations agree, which is not the question.
 *
 * Proportional to each refund's own amount: a customer who got 30% back had 30% of our fee returned
 * with it. The newest row absorbs the flooring remainder, so Σ always equals `total` exactly and
 * pennies are never lost. Idempotent — same inputs, same values, so re-running corrects rather than
 * accumulates.
 */
export function splitFeeRefund(
  refunds: Array<{ id: string; amount: number; created: Date }>,
  total: number,
): Array<{ id: string; value: number }> {
  if (!refunds.length) return [];
  const gross = refunds.reduce((a, r) => a + r.amount, 0);
  if (gross <= 0) return [];
  const ordered = refunds.slice().sort((a, b) => a.created.getTime() - b.created.getTime());
  let assigned = 0;
  return ordered.map((r, i) => {
    const v = i === ordered.length - 1 ? total - assigned : Math.floor((total * r.amount) / gross);
    assigned += v;
    return { id: r.id, value: Math.max(0, v) };
  });
}

/**
 * Write the fee-refund attribution across a payment's refund rows so that Σ equals `total`.
 */
async function stampFeeRefunds(paymentId: string, refunds: RefundLite[], total: number): Promise<void> {
  const shares = splitFeeRefund(refunds, total);
  for (const s of shares) {
    await prisma.refund.updateMany({
      where: { payment_id: paymentId, refund_id: s.id },
      data: { application_fee_refunded_pennies: s.value },
    });
  }
}

/** A card attempt that ended without money. Terminal, and it frees the invoice of a pending row. */
export async function closeCardPayment(paymentIntentId: string, status: 'failed' | 'canceled'): Promise<boolean> {
  const r = await prisma.$transaction(async (tx: Prisma.TransactionClient) => closePaymentByRef(tx, paymentIntentId, status));
  return r.closed;
}
