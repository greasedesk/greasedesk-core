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
 * A gate cannot call Stripe. So the parameters are built here, pure, and the gate reads what is
 * actually sent — not that some source text exists.
 *
 * ── HOW A DISCOUNT IS REMOVED, AND THE TWO WAYS THE OBVIOUS ANSWER FAILS ────────────────────────
 * This field was `discounts: []` for a day, with a paragraph here explaining that `discounts`
 * REPLACES whatever is on the subscription. It does not, and rehearsal D1 caught it: a garage
 * switched from yearly to monthly kept its £300 once-only coupon, and its first £75 invoice came
 * out at £0.00. Two independent faults, either of which alone was enough:
 *
 *  1. Stripe's own words, in node_modules/stripe/cjs/resources/Subscriptions.d.ts on the update
 *     params: "A populated array overwrites the existing discounts on the subscription. If not
 *     specified OR EMPTY ARRAY, it leaves the subscription's discounts UNCHANGED. If empty string,
 *     it clears the subscription's discounts." An empty array is the one value that means "leave
 *     it alone" — the exact opposite of what was intended.
 *  2. Even had the API honoured it, the field never left this process. stripe-node form-encodes
 *     its parameters, and an empty array encodes to nothing at all: `{ discounts: [] }` serialises
 *     to `""`. So Stripe was not sent an empty list; Stripe was sent no `discounts` field.
 *
 * Hence the empty STRING. `''` encodes to `discounts=`, which is the documented clear. The gate
 * asserts the encoded request body through stripe-node's own transport, because an assertion on
 * this object would have passed on both days — it was never the object that was wrong.
 *
 * Why it matters enough for all that: a duration:'once' first-year coupon left behind after a
 * switch to MONTHLY comes off the first £75 invoice instead of a £750 one — the offer spent on a
 * month, and the garage's real first year charged at full price later.
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
    // ATTACH with a populated array; CLEAR with the empty string. NOT []. See the header.
    discounts: a.couponId ? [{ coupon: a.couponId }] : '',
    metadata: a.metadata,
  } as Stripe.SubscriptionUpdateParams;
}
