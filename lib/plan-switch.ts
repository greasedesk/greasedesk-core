/**
 * File: lib/plan-switch.ts
 * THE EXACT PARAMETERS A PLAN SWITCH SENDS TO STRIPE, built where they can be asserted.
 *
 * ── WHY THIS IS A FUNCTION AND NOT AN OBJECT LITERAL IN THE HANDLER ─────────────────────────────
 * change-plan resolved the offer, reported `discountPennies` in its JSON response, and never told
 * Stripe about it. The subscription came out at the full renewal figure with no coupon, so a garage
 * quoted £450 on the licences screen would have been charged £750 when its trial ended. The clause
 * that was supposed to cover this scanned the SOURCE for `offerFor(prisma, groupId)` — it passed
 * throughout, and later went red over a comma.
 *
 * A gate cannot call Stripe. So the parameters are built here, pure, and the gate reads the object
 * that is actually sent: `discounts` present going one way, EMPTY going the other. That is the
 * difference between asserting the behaviour and asserting that some source text exists.
 *
 * ── `discounts: []` IS NOT A TIDINESS DETAIL ────────────────────────────────────────────────────
 * `discounts` REPLACES whatever is on the subscription. A duration:'once' first-year coupon left
 * behind after a switch to MONTHLY comes off the first £75 invoice instead of a £750 one — the
 * offer spent on a month, and the garage's real first year charged at full price later. So the
 * field is stated on every switch rather than omitted when there is nothing to attach.
 */
import type Stripe from 'stripe';

export function planSwitchParams(a: {
  itemId: string;
  /** From subscriptionLineFor: either { price } or { price_data }. */
  line: Record<string, unknown>;
  quantity: number;
  /** Stripe's own trial_end, carried through untouched: a switch changes the amount, never the date. */
  trialEnd: number | null | undefined;
  metadata: Record<string, string>;
  /** The first-year coupon id, or null when this switch must carry no discount. */
  couponId: string | null;
}): Stripe.SubscriptionUpdateParams {
  return {
    items: [{ id: a.itemId, ...(a.line as any), quantity: a.quantity }],
    proration_behavior: 'none',   // stated, not inherited — see the change-plan header
    trial_end: a.trialEnd ?? undefined,
    discounts: a.couponId ? [{ coupon: a.couponId }] : [],
    metadata: a.metadata,
  } as Stripe.SubscriptionUpdateParams;
}
