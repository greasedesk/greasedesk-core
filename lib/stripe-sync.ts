/**
 * File: lib/stripe-sync.ts
 * Subscription quantity ↔ site count (item-12). A Site is a billable unit; adding/removing one sets
 * the subscription's quantity to the live site count and lets STRIPE do the proration. Idempotency
 * key = subscription + quantity, so a replay is a no-op. Best-effort + dormant: no Stripe / no
 * subscription → returns quietly (the site write must never fail because billing isn't wired).
 */
import { prisma } from '@/lib/db';
import { getStripe } from '@/lib/stripe';

export async function syncSubscriptionQuantity(groupId: string): Promise<void> {
  const stripe = getStripe();
  if (!stripe) return;
  try {
    const billing = await prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { stripe_subscription_id: true } });
    if (!billing?.stripe_subscription_id) return; // pre-Checkout — nothing to re-rate
    const quantity = Math.max(1, await prisma.site.count({ where: { group_id: groupId } }));
    const sub = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    const item = sub.items.data[0];
    if (!item || item.quantity === quantity) return; // already correct → no-op
    await stripe.subscriptions.update(
      billing.stripe_subscription_id,
      { items: [{ id: item.id, quantity }], proration_behavior: 'create_prorations' },
      { idempotencyKey: `qty:${billing.stripe_subscription_id}:${quantity}` },
    );
  } catch (e: any) {
    console.error('[stripe] quantity sync failed', e?.message); // never blocks the site write
  }
}
