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

    // ── A SUBSCRIPTION MANAGED BY A SCHEDULE REFUSES THIS UPDATE (2026-10-29) ─────────────────
    // A garage that has held a move to monthly for its renewal (pages/api/stripe/change-plan, the
    // fourteen-day window) carries a Stripe schedule for the fortnight before that date. Item
    // changes on such a subscription belong to the schedule's phases, so this call would fail —
    // and the catch below swallows it, so a location added in that fortnight would simply never
    // be billed for, with one line in a log nobody reads.
    //
    // It is NOT fixed here. Re-rating through the schedule means rewriting the paid year's phase,
    // which is the one thing that design refuses to do casually. So this says so, by name, in the
    // record rather than the log — a site that went unbilled has to be findable afterwards.
    if (sub.schedule) {
      const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id;
      console.error(`[stripe] quantity sync SKIPPED for ${groupId}: subscription is managed by schedule ${scheduleId} — ${item.quantity} sites billed, ${quantity} sites held`);
      const { writeAudit } = await import('@/lib/audit');
      await writeAudit(prisma as any, {
        groupId, userId: null,
        action: 'billing.quantity_sync_blocked', entity: 'group', entityId: groupId,
        diff: { billedQuantity: item.quantity ?? null, actualSites: quantity, scheduleId },
      }).catch(() => {});
      return;
    }
    await stripe.subscriptions.update(
      billing.stripe_subscription_id,
      { items: [{ id: item.id, quantity }], proration_behavior: 'create_prorations' },
      { idempotencyKey: `qty:${billing.stripe_subscription_id}:${quantity}` },
    );
  } catch (e: any) {
    console.error('[stripe] quantity sync failed', e?.message); // never blocks the site write
  }
}
