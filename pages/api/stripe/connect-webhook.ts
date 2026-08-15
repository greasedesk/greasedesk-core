/**
 * File: pages/api/stripe/connect-webhook.ts
 * Stripe CONNECT events — the state of a garage's own account. Signature-verified against
 * STRIPE_CONNECT_WEBHOOK_SECRET.
 *
 * ── A SEPARATE ENDPOINT FROM THE PLATFORM WEBHOOK, ON PURPOSE ───────────────────────────────────
 * Connect events are delivered to a separately-registered endpoint with its OWN signing secret, and
 * they carry an `account` field naming the connected account rather than describing GreaseDesk's own
 * subscription. Folding them into pages/api/stripe/webhook would mean one handler switching on two
 * unrelated meanings of "this event is about X", with two secrets — and that webhook is the ONLY
 * writer of subscription state, which is not a thing to make busier.
 *
 * ── SILENCE IS THE FAILURE MODE THIS EXISTS TO PREVENT ──────────────────────────────────────────
 * A garage whose account gets restricted finds out when a customer's card is declined at the
 * counter. Every event here ends in a column the product reads, so it can say what happened in
 * words instead of failing quietly later.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { applyAccount, markDisconnected, groupForAccount } from '@/lib/stripe-connect';
import { fulfilCardPayment, enrichCardPayment, closeCardPayment, recordCardRefunds } from '@/lib/card-payment-fulfil';
import { sendInvoiceEmail } from '@/lib/invoice-email-send';

export const config = { api: { bodyParser: false } };

/** Same raw-body read as the platform webhook — signature verification needs the exact bytes. */
function readRaw(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let len = 0;
    req.on('data', (c) => { const u = c as Uint8Array; chunks.push(u); len += u.length; });
    req.on('end', () => {
      const merged = new Uint8Array(len); let off = 0;
      for (const u of chunks) { merged.set(u, off); off += u.length; }
      resolve(Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength));
    });
    req.on('error', reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const stripe = getStripe();
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  // 400, not 503: an unconfigured secret means signatures cannot be checked, and an unverified
  // Connect event must never be allowed to write account state.
  if (!stripe || !secret) return res.status(400).json({ message: 'Connect webhook not configured.' });

  let event: Stripe.Event;
  try {
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(raw as any, req.headers['stripe-signature'] as string, secret);
  } catch (e: any) {
    console.error('[connect-webhook] signature verification failed', e?.message);
    return res.status(400).json({ message: 'Invalid signature.' });
  }

  // IDEMPOTENCY on event.id, the same StripeEvent table the platform webhook uses. Stripe retries;
  // an account sync run twice is harmless, but a create would not be, and the next handler added
  // here inherits the guard for free.
  try {
    await prisma.stripeEvent.create({ data: { event_id: event.id, type: event.type, livemode: event.livemode } });
  } catch {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'account.updated': {
        const acct = event.data.object as Stripe.Account;
        // Resolved by the account id we stored, NOT by the metadata we set at creation: metadata is
        // editable by anyone with access to that Stripe account, and this decides whether a garage
        // can take money.
        const groupId = await groupForAccount(acct.id);
        if (!groupId) { console.warn('[connect-webhook] account.updated for an unknown account', acct.id); break; }
        // The event carries livemode; pass it rather than making applyAccount ask Stripe again.
        await applyAccount(groupId, acct, event.livemode);
        break;
      }
      case 'account.application.deauthorized': {
        // The `account` field on the event is the connected account that revoked us; the object is
        // the application. Nothing to sync — the account is no longer ours to read.
        if (event.account) await markDisconnected(event.account);
        break;
      }
      // ── FULFILMENT. The only event that turns a card intent into money. ────────────────────
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const r = await fulfilCardPayment({ paymentIntentId: pi.id });
        if (r.outcome === 'not_ours') {
          // The garage's account is theirs: a Terminal sale, a dashboard payment, another product
          // entirely. We have no row and must not invent an invoice for it. Recorded, not an error.
          console.info('[connect-webhook] payment_intent.succeeded for an intent we did not create —', pi.id, 'account', event.account ?? '—');
          break;
        }
        if (r.outcome === 'already_done') { console.info('[connect-webhook] redelivered fulfilment, no-op —', pi.id); break; }

        // ── AFTER THE MONEY IS COMMITTED, AND ONLY THEN ──────────────────────────────────────
        // Both of these can fail without costing us the payment, which is why they are out here
        // rather than inside the transaction (financial-write-first).
        if (event.account) await enrichCardPayment({ paymentIntent: pi, accountId: event.account });
        if (r.fullyPaid) {
          // THE receipt, through the one send path. offersPayLink refuses a `paid` invoice, so this
          // carries no "pay now" button — a receipt that asks for money again is how a garage gets
          // a phone call.
          const sent = await sendInvoiceEmail(r.invoiceId, r.groupId, null);
          if (!sent.ok) console.error('[connect-webhook] receipt send failed for', r.invoiceId, sent.code);
        }
        break;
      }
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        // Terminal, and different facts: a declined card is not an abandoned checkout. Closing the
        // row keeps a dead `processing` attempt from sitting on the invoice forever.
        const pi = event.data.object as Stripe.PaymentIntent;
        const status = event.type === 'payment_intent.canceled' ? 'canceled' : 'failed';
        const closed = await closeCardPayment(pi.id, status);
        console.info('[connect-webhook]', event.type, pi.id, closed ? `closed as ${status}` : 'no in-flight row of ours');
        break;
      }
      // ── MONEY GIVEN BACK, usually from the garage's OWN dashboard ─────────────────────────
      // Handled because the garage cannot do the whole job themselves: Stripe permits only the
      // application that created the charge to return the application fee, so without this their
      // refund leaves our cut taken on money they have handed back.
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const r = await recordCardRefunds({ charge, accountId: event.account ?? '' });
        console.info('[connect-webhook] charge.refunded', charge.id,
          `${r.recorded} refund row(s)`,
          r.feeRefundedPennies == null ? 'application fee NOT returned' : `application fee returned: ${r.feeRefundedPennies}p`);
        break;
      }
      case 'payout.paid':
      case 'payout.failed': {
        // Recorded but not acted on: a held or failed payout breaks nothing in GreaseDesk and there
        // is nothing we can do about it. It is logged so that when the garage rings, the answer is
        // "Stripe is holding your payout" rather than a shrug.
        console.info('[connect-webhook]', event.type, 'for', event.account ?? 'unknown account');
        break;
      }
      default:
        break; // unhandled types are recorded in StripeEvent and ignored
    }
  } catch (e: any) {
    console.error('[connect-webhook] processing error', event.type, e?.message);
    // 500 so Stripe RETRIES. The StripeEvent row is already written, so the retry would be swallowed
    // as a duplicate — delete it, or the failure is permanent and silent.
    await prisma.stripeEvent.delete({ where: { event_id: event.id } }).catch(() => {});
    return res.status(500).json({ message: 'Processing error.' });
  }
  return res.status(200).json({ received: true });
}
