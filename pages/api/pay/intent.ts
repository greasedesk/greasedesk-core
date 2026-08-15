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
import { logStripeFailure, stripeFailureBody } from '@/lib/stripe-errors';

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
    if (!result.ok) return res.status(409).json(result.refusal);
    return res.status(200).json(result.intent);
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    // Our own preconditions. `not_configured` is a fact about OUR deployment and must not be dressed
    // as the garage's problem, but the customer only needs one sentence either way.
    if (msg.startsWith('PAY:')) {
      console.error('[pay] refused by us', msg, 'invoice', link.link.invoiceId);
      return res.status(409).json({ code: 'unavailable', message: 'Card payment isn’t available for this invoice. Please contact the garage.' });
    }
    // No rate configured. Loud, because it means we would otherwise be charging a fee of zero.
    if (msg.startsWith('APPFEE:')) {
      console.error('[pay] NO APPLICATION FEE RATE —', msg);
      return res.status(409).json({ code: 'unavailable', message: 'Card payment isn’t available for this invoice. Please contact the garage.' });
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
