/**
 * File: lib/sms-topup.ts
 * Buying more SMS. One Checkout session, one webhook, one row.
 *
 * ── THE PRICE LIVES IN STRIPE, NOT HERE ─────────────────────────────────────────────────────────
 * A Price ID from the environment, exactly like the £75 subscription — so changing what a pack
 * costs is a Stripe action, not a deploy, and there is no second copy of a money figure to go stale.
 * What IS ours is the QUANTITY a pack contains (lib/sms-allowance::SMS_TOPUP_PACK), because that is
 * a product rule rather than a price.
 *
 * ── ONE-OFF PAYMENT, NOT A SUBSCRIPTION CHANGE ──────────────────────────────────────────────────
 * `mode: 'payment'`. That matters beyond Stripe: the platform webhook's existing
 * checkout.session.completed handler was written for the subscription flow and writes
 * stripe_customer_id / stripe_subscription_id onto GroupBilling. A payment-mode session reaching
 * that branch would rewrite a tenant's billing link from a top-up — so the handler now branches on
 * mode BEFORE any of that runs.
 *
 * ── THE SESSION ID IS THE IDEMPOTENCY KEY ───────────────────────────────────────────────────────
 * SmsTopUp.source_ref is unique on it, so a redelivered webhook is a no-op rather than a second
 * hundred messages. Same rule as Payment.source_ref and CommissionEntry.
 */
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getStripe, appBaseUrl } from '@/lib/stripe';
import { SMS_TOPUP_PACK } from '@/lib/sms-allowance';

export const smsTopUpPriceId = (): string | null => process.env.STRIPE_PRICE_SMS_TOPUP ?? null;

/** How many packs a caller may buy at once. A slip on a number field must not be a £500 mistake. */
export const MAX_PACKS_PER_PURCHASE = 10;

export type TopUpRefusal = { code: string; message: string };

/**
 * Start a purchase. Refusals are sentences — this reaches a garage owner who wants to keep texting.
 */
export async function startTopUpCheckout(args: {
  groupId: string;
  packs: number;
}): Promise<{ ok: true; url: string } | { ok: false; refusal: TopUpRefusal }> {
  // ── THE REQUEST BEFORE THE ENVIRONMENT ───────────────────────────────────────────────────────
  // Third time this ordering has come up — refuseConnect had it backwards, so did the account
  // session endpoint. "Top-ups aren't switched on for this environment" is a fact about US, and
  // telling someone that when what they actually did was ask for fifteen packs is both unhelpful
  // and wrong the moment the key lands. What the caller sent is checked first, always.
  if (!Number.isInteger(args.packs) || args.packs < 1 || args.packs > MAX_PACKS_PER_PURCHASE) {
    return { ok: false, refusal: { code: 'bad_quantity', message: `Choose between 1 and ${MAX_PACKS_PER_PURCHASE} packs.` } };
  }
  const stripe = getStripe();
  const price = smsTopUpPriceId();
  if (!stripe || !price) {
    return { ok: false, refusal: { code: 'not_configured', message: 'Top-ups aren’t switched on for this environment yet.' } };
  }

  const billing = await prisma.groupBilling.findUnique({
    where: { group_id: args.groupId },
    select: { stripe_customer_id: true },
  });

  const base = appBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price, quantity: args.packs }],
    // REUSE THE EXISTING STRIPE CUSTOMER when there is one. A second customer for the same tenant
    // splits their payment history in Stripe's own dashboard and is the thing most likely to confuse
    // whoever reconciles it later.
    ...(billing?.stripe_customer_id ? { customer: billing.stripe_customer_id } : {}),
    client_reference_id: args.groupId,
    // The webhook reads `packs` from here rather than re-deriving it from the line item, because a
    // price's quantity and our pack size are two different numbers and only one of them is ours.
    metadata: { group_id: args.groupId, purpose: 'sms_topup', packs: String(args.packs) },
    success_url: `${base}/admin/messages?topup=done`,
    cancel_url: `${base}/admin/messages?topup=cancelled`,
  });
  return { ok: true, url: session.url as string };
}

/**
 * Record a completed purchase. Idempotent on the session id: a redelivered webhook returns null
 * rather than granting a second pack.
 *
 * Reads the pack count from metadata WE set, never from the line items — the quantity on the price
 * is how many packs were bought, and the size of a pack is a product rule that could change between
 * the purchase and the webhook.
 */
export async function recordTopUpFromSession(session: Stripe.Checkout.Session): Promise<{ granted: number } | null> {
  const groupId = session.metadata?.group_id || session.client_reference_id;
  if (!groupId || session.metadata?.purpose !== 'sms_topup') return null;
  // PAID, not merely completed. A session can complete with an async payment method still pending,
  // and granting messages for money that has not arrived is the shape this whole codebase avoids.
  if (session.payment_status !== 'paid') {
    console.info('[sms-topup] session', session.id, 'completed but payment_status is', session.payment_status, '— not granting');
    return null;
  }

  const packs = Number(session.metadata?.packs ?? 0);
  if (!Number.isInteger(packs) || packs < 1) {
    console.error('[sms-topup] session', session.id, 'has no usable pack count in metadata —', session.metadata?.packs);
    return null;
  }
  const quantity = packs * SMS_TOPUP_PACK;

  try {
    await prisma.smsTopUp.create({
      data: {
        group_id: groupId,
        quantity,
        amount_pennies: session.amount_total ?? null,
        source_ref: session.id,
      },
    });
    return { granted: quantity };
  } catch (e: any) {
    if (e?.code === 'P2002') return null; // already recorded — a redelivery, not a problem
    throw e;
  }
}
