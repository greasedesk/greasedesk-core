/**
 * File: lib/stripe-billing-cache.ts
 * THE one place a Stripe Subscription is projected onto the GroupBilling cache (item-12/13).
 * Shared by the async webhook (post-onboarding: renew/cancel/card-fail) AND the synchronous
 * onboarding confirm (checkout return). Both write Stripe's CURRENT truth, so the write is
 * idempotent — a webhook that lands after the confirm is a no-op, and a confirm that beats the
 * webhook simply lets the paid tenant through without waiting at a spinner.
 *
 * IMPORTANT distinction from "the redirect writes nothing": we NEVER trust the redirect's query
 * params. The subscription object here comes from an authenticated server-side Stripe API call
 * (webhook-verified event, or stripe.checkout.sessions/subscriptions.retrieve) — that IS Stripe's
 * truth, not the untrusted browser round-trip.
 *
 * Also mirrors Stripe's trial_end onto Group.trial_ends_at so Stripe owns the trial clock — the
 * local signup timestamp is no longer the source of truth (item-13).
 */
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { billingStatusFromStripe } from '@/lib/billing';

/** Map a Stripe subscription onto GroupBilling (+ the trial clock on Group). Resolves the tenant by
 *  customer id, falling back to an explicit groupId (first confirm, before the customer is cached). */
export async function applyStripeSubscriptionToCache(sub: Stripe.Subscription, fallbackGroupId?: string | null): Promise<string | null> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const byCustomer = customerId
    ? await prisma.groupBilling.findFirst({ where: { stripe_customer_id: customerId }, select: { group_id: true } })
    : null;
  const groupId = byCustomer?.group_id ?? fallbackGroupId ?? null;
  if (!groupId) return null;

  const periodEnd = (sub as any).current_period_end ? new Date((sub as any).current_period_end * 1000) : null;
  const trialEnd = (sub as any).trial_end ? new Date((sub as any).trial_end * 1000) : null;

  await prisma.groupBilling.update({
    where: { group_id: groupId },
    data: {
      stripe_customer_id: customerId ?? undefined,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status,
      current_period_end: periodEnd,
      status: billingStatusFromStripe(sub.status), // coarse projection for display
    },
  });

  // Stripe owns the trial clock once a subscription exists (item-13): mirror trial_end onto Group.
  if (trialEnd) {
    await prisma.group.update({ where: { id: groupId }, data: { trial_ends_at: trialEnd } }).catch(() => {});
  }

  return groupId;
}
