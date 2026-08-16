/**
 * File: pages/api/payments/refund.ts
 * POST { paymentId, amountPennies } → ask Stripe to refund. WRITES NOTHING.
 *
 * ── THE CONSTRAINT THIS ENDPOINT EXISTS TO HONOUR ───────────────────────────────────────────────
 * Refunds reach us from three directions: this button, the garage's own Stripe dashboard (they are
 * on Standard accounts and have full access), and the API. If our button wrote the ledger directly
 * it would be a FOURTH path — one that produces rows the other three cannot, and that disagrees with
 * them the moment anything goes wrong. That is today's defect rebuilt deliberately.
 *
 * So this calls stripe.refunds.create and stops. The `charge.refunded` / `refund.created` webhook
 * writes the Refund row, reconciles the invoice cache and returns our application fee — exactly as
 * it does for a dashboard refund, because from its side there is no difference. One writer, three
 * origins, and the origin genuinely does not matter.
 *
 * A consequence worth stating: SUCCESS HERE IS NOT A SETTLED LEDGER. The response says Stripe
 * accepted it, not that our rows have caught up. The UI says so in those terms rather than claiming
 * a refund is "done" while the webhook is still in flight.
 *
 * ── AUTHORITY ───────────────────────────────────────────────────────────────────────────────────
 * Manager-and-above on the site the invoice belongs to — the same bar as issuing and unlocking. A
 * refund is a money decision, and canManageSite is where money decisions already live.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { getStripe } from '@/lib/stripe';
import { readConnection, providerState } from '@/lib/provider-connection';
import { quoteRefund } from '@/lib/refund-quote';
import { logStripeFailure, stripeFailureBody, isStripeError } from '@/lib/stripe-errors';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const paymentId = String((req.body ?? {}).paymentId ?? '');
  const amountPennies = Number((req.body ?? {}).amountPennies);

  const pay = (await prisma.payment.findFirst({
    where: { id: paymentId, group_id: user.group_id },
    select: {
      id: true, site_id: true, status: true, provider: true, amount_pennies: true, currency: true,
      charge_id: true, payment_intent_id: true, application_fee_pennies: true, stripe_fee_pennies: true,
      invoice: { select: { id: true, invoice_number: true, job_card_id: true } },
      refunds: { select: { amount_pennies: true, application_fee_refunded_pennies: true } },
    },
  })) as any;
  if (!pay) return res.status(404).json({ message: 'Payment not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, pay.site_id)) return res.status(403).json({ message: 'You do not have access to this payment.' });

  // ── ONLY A REAL, SETTLED CARD PAYMENT ──────────────────────────────────────────────────────
  // A `processing` intent has not cleared and Stripe would refuse; a manual cash payment is not
  // ours to reverse and never went through Stripe at all. Both are refusals with their own words,
  // because "cannot refund" for two different reasons is two different things to do next.
  if (pay.provider !== 'stripe') {
    return res.status(409).json({ code: 'not_card', message: 'This payment wasn’t taken by card online, so there’s nothing for us to refund. Return it however it was taken and record it on the invoice.' });
  }
  if (pay.status !== 'succeeded') {
    return res.status(409).json({ code: 'not_settled', message: 'This payment hasn’t cleared yet, so it can’t be refunded. It will either clear or fail shortly.' });
  }

  const alreadyRefunded = pay.refunds.reduce((a: number, r: any) => a + (r.amount_pennies ?? 0), 0);
  const feeAlreadyBack = pay.refunds.reduce((a: number, r: any) => a + (r.application_fee_refunded_pennies ?? 0), 0);

  // THE SAME ARITHMETIC THE DIALOG SHOWED. Re-derived here, never taken from the page — a browser
  // that has been open since this morning may be quoting a payment that has since been part-refunded.
  const q = quoteRefund({
    amountPennies: pay.amount_pennies,
    refundPennies: amountPennies,
    alreadyRefundedPennies: alreadyRefunded,
    applicationFeePennies: pay.application_fee_pennies,
    stripeFeePennies: pay.stripe_fee_pennies,
    applicationFeeAlreadyReturnedPennies: feeAlreadyBack,
  });
  if (!q.ok) return res.status(409).json({ ...q.refusal, retryable: false });

  const stripe = getStripe();
  const state = providerState(await readConnection(user.group_id, 'stripe'));
  if (!stripe || state.status !== 'ready' || !state.externalId) {
    return res.status(409).json({ code: 'not_ready', message: 'Card payments aren’t connected for this site at the moment, so a refund can’t be sent.' });
  }

  try {
    const refund = await stripe.refunds.create(
      {
        ...(pay.payment_intent_id ? { payment_intent: pay.payment_intent_id } : { charge: pay.charge_id! }),
        amount: q.quote.refundPennies,
        // Our fee comes back separately, from the platform, in the webhook. Asking Stripe to do it
        // here would be a second mover on the same money.
        refund_application_fee: false,
      },
      {
        stripeAccount: state.externalId,
        // A double-click must not refund twice. Keyed on the payment AND the running total, so a
        // SECOND, DELIBERATE partial of the same size is still allowed through — which a key on the
        // amount alone would silently swallow.
        idempotencyKey: `refund:${pay.id}:${alreadyRefunded}:${q.quote.refundPennies}`,
      },
    );

    // AUDIT THE REQUEST, NOT THE OUTCOME. This is the record that a person at the garage asked for
    // it — the money movement is the webhook's to record. Both halves matter and they are different
    // facts: `refund.requested` has a user_id, the Refund row does not.
    await writeAudit(prisma, {
      groupId: user.group_id, userId: user.id as string, jobCardId: pay.invoice?.job_card_id ?? null,
      action: 'refund.requested',
      diff: {
        invoice: pay.invoice?.invoice_number ?? null, paymentId: pay.id, refundId: refund.id,
        amountPennies: q.quote.refundPennies, partial: !q.quote.isFull,
        stripeFeeKeptPennies: q.quote.stripeFeeKeptPennies,
      },
    }).catch(() => {});

    // NOT "refunded". Stripe has accepted it; our ledger catches up when the webhook lands.
    return res.status(200).json({
      ok: true, refundId: refund.id, status: refund.status,
      amountPennies: q.quote.refundPennies, isFull: q.quote.isFull,
      message: q.quote.isFull
        ? 'Refund sent to Stripe. The invoice will show as refunded once it confirms — usually a few seconds.'
        : 'Partial refund sent to Stripe. The invoice will update once it confirms — usually a few seconds.',
    });
  } catch (e: any) {
    if (!isStripeError(e)) {
      console.error('[refund] OUR BUG — not a Stripe error. payment', pay.id, '—', String(e?.stack ?? e?.message ?? e));
      return res.status(500).json({ code: 'internal', retryable: true, message: 'Something went wrong sending the refund. Please try again in a moment.' });
    }
    const f = logStripeFailure('refunds.create', e);
    return res.status(f.status).json({
      ...stripeFailureBody(f),
      message: f.retryable
        ? 'The refund couldn’t be sent just now. Please try again in a moment.'
        : `Stripe refused the refund${f.stripeMessage ? `: ${f.stripeMessage}` : '.'}`,
    });
  }
}
