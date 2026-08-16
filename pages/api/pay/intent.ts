/**
 * File: pages/api/pay/intent.ts
 * POST { token } → a PaymentIntent client secret for the invoice that token opens.
 *
 * AUTHENTICATED BY THE MAGIC LINK ALONE, like pages/api/quote-respond. There is no session; the
 * token IS the credential. This is the first endpoint to move money on that basis, which the
 * amended magic-link rule permits (2026-08-15) because the movement is TOWARD a frozen, named
 * invoice — see lib/magic-link for the reasoning and the exposures.
 *
 * ── THE BODY CARRIES A TOKEN AND NOTHING ELSE ───────────────────────────────────────────────────
 * No amount, no invoice id, no account. Everything is derived server-side from what the token
 * resolves to. There is nothing a caller can put in this request that changes what is charged.
 *
 * ── CARD TESTING IS THE REAL THREAT HERE ────────────────────────────────────────────────────────
 * A public endpoint that mints PaymentIntents is a card-testing target. The charges land on the
 * GARAGE's Stripe account where Radar is the actual defence, but we must not be the cheap way in,
 * so this limits harder than the magic-link resolver's own 60/hour: a customer paying one invoice
 * needs one intent, not ten. Limited per IP and per LINK, because a leaked link hammered from a
 * botnet is the case a per-IP limit alone would miss.
 *
 * FAIL-CLOSED, via takeTokenStrict. lib/auth-rate-limit's own header draws the line: the fail-open
 * variant "is WRONG the moment a call costs money", and while a PaymentIntent costs US nothing
 * directly, it is the surface an attacker uses to test stolen cards. A limiter that opens during a
 * database blip hands them an unbounded window at the moment of their choosing; a customer who
 * cannot pay for thirty seconds presses the button again. "We couldn't check, so we didn't start a
 * payment" is the recoverable answer.
 *
 * A refusal is a sentence for the customer, never a code. They are standing at a counter.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveMagicLink } from '@/lib/magic-link';
import { clientIp, takeTokenStrict } from '@/lib/auth-rate-limit';
import { createInvoicePaymentIntent } from '@/lib/invoice-payment-intent';
import { logStripeFailure, stripeFailureBody, isStripeError } from '@/lib/stripe-errors';

/** One customer paying one invoice needs a couple of attempts, not a couple of hundred. */
export const PAY_LIMITS = {
  perIp: { max: 10, windowMinutes: 60 },
  perLink: { max: 6, windowMinutes: 60 },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const token = String((req.body ?? {}).token ?? '');
  const ip = clientIp(req.headers as any);

  if (!(await takeTokenStrict(`pay:ip:${ip}`, PAY_LIMITS.perIp.max, PAY_LIMITS.perIp.windowMinutes))) {
    return res.status(429).json({ code: 'rate_limited', message: 'Too many attempts from this connection. Please wait a little while and try again.' });
  }

  // recordUse:false — opening the payment form is not "using" the link in the sense the audit trail
  // means; the customer already consumed it by viewing the invoice. Counting it twice would make
  // use_count a measure of button presses rather than of who saw what.
  const link = await resolveMagicLink(token, { ip, recordUse: false });
  if (!link.ok) {
    // Deliberately terse and identical across causes. The pay endpoint is not the place to teach a
    // token-guesser which of their guesses once existed; /c/[token] explains itself properly to a
    // real customer who followed a real link.
    return res.status(404).json({ code: 'no_link', message: 'This payment link is no longer valid. Please contact the garage.' });
  }
  if (link.link.purpose !== 'invoice_pay' || !link.link.invoiceId) {
    return res.status(400).json({ code: 'wrong_link', message: 'This link doesn’t open a payment.' });
  }

  if (!(await takeTokenStrict(`pay:link:${link.link.id}`, PAY_LIMITS.perLink.max, PAY_LIMITS.perLink.windowMinutes))) {
    return res.status(429).json({ code: 'rate_limited', message: 'Too many attempts on this invoice. Please wait a little while and try again.' });
  }

  try {
    const result = await createInvoicePaymentIntent({ groupId: link.link.groupId, invoiceId: link.link.invoiceId });
    // A REFUSAL IS SETTLED. Every one of these is a fact about the document, the garage's account
    // or our configuration — none of them changes because the customer presses again, so they
    // carry retryable:false and the panel stops offering the button. It was the missing flag here
    // that left a Pay button sitting beside its own denial.
    if (!result.ok) {
      // ── OUR CONFIGURATION IS NOT THE CUSTOMER'S BUSINESS ──────────────────────────────────
      // Facts about the DOCUMENT (void, settled, under correction) and about the GARAGE (not_ready)
      // are useful and safe to name. Facts about OUR deployment are not: this endpoint is public
      // and unauthenticated, and "no application fee rate configured" on a 409 tells an outsider
      // about our internals for no benefit to anyone standing at a counter. The old code collapsed
      // these to `unavailable` and the refactor leaked them; the real code is logged instead.
      const OURS = new Set(['not_configured', 'no_rate']);
      if (OURS.has(result.refusal.code)) {
        console.error('[pay] refused by our configuration —', result.refusal.code, 'invoice', link.link.invoiceId, 'group', link.link.groupId);
        return res.status(409).json({ code: 'unavailable', retryable: false, message: result.refusal.message });
      }
      return res.status(409).json({ ...result.refusal, retryable: false });
    }
    return res.status(200).json(result.intent);
  } catch (e: any) {
    const msg = String(e?.message ?? '');

    // ── OUR OWN PRECONDITIONS ────────────────────────────────────────────────────────────────
    // Settled: nothing the customer does changes them.
    if (msg.startsWith('PAY:') && msg !== 'PAY:binding_failed') {
      console.error('[pay] refused by us', msg, 'invoice', link.link.invoiceId);
      return res.status(409).json({ code: 'unavailable', retryable: false, message: 'Card payment isn’t available for this invoice. Please contact the garage.' });
    }

    // ── THE INTENT EXISTS BUT WE FAILED TO RECORD IT ─────────────────────────────────────────
    // Already logged loudly, with the intent id, by lib/invoice-payment-intent. RETRYABLE, and
    // genuinely so: the idempotency key replays the same intent and the binding is attempted
    // again, which is the recovery. Telling this customer to ring the garage would strand a
    // payable invoice behind a transient database failure.
    if (msg === 'PAY:binding_failed') {
      return res.status(503).json({ code: 'binding_failed', retryable: true, message: 'The payment couldn’t be started just now. Please try again in a moment.' });
    }

    // ── STRIPE'S FAULT, OR OURS? ─────────────────────────────────────────────────────────────
    // Asked before reaching for the classifier. Everything used to go through logStripeFailure,
    // so a Prisma error from the transaction AFTER the Stripe call was logged as
    // "paymentIntents.create failed", classified UNKNOWN — because it is not a Stripe error —
    // and shown to the customer in Stripe's non-retryable wording. One sentence for four causes
    // and a log line naming the wrong operation: that combination is why a live refusal on TMBS
    // could not be diagnosed from what we had recorded.
    if (!isStripeError(e)) {
      console.error('[pay] OUR BUG — not a Stripe error. invoice', link.link.invoiceId,
        'group', link.link.groupId, '—', String(e?.stack ?? e?.message ?? e));
      // Treated as retryable DELIBERATELY. We do not know whether our own fault is transient, and
      // of the two ways to be wrong, leaving the button on a payable invoice is the recoverable
      // one; removing it makes an invoice that Stripe would happily charge look unpayable.
      return res.status(500).json({
        code: 'internal', retryable: true,
        message: 'Something went wrong starting the payment. Please try again in a moment.',
      });
    }

    const f = logStripeFailure('paymentIntents.create', e);
    // The classifier's own sentences are written for a GARAGE OWNER reading the Payments page, not
    // for a customer — "our Stripe credentials aren't allowed to do this" means nothing to them.
    // The code and the retryable flag ride along so the page can decide whether to offer a retry.
    return res.status(f.status).json({
      ...stripeFailureBody(f),
      message: f.retryable
        ? 'The payment couldn’t be started just now. Please try again in a moment.'
        : 'Card payment isn’t available for this invoice. Please contact the garage.',
    });
  }
}
