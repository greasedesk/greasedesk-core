/**
 * File: lib/stripe-period.ts
 * WHEN DOES THIS SUBSCRIPTION RENEW? One reader, because the answer moved and nobody noticed.
 *
 * `subscription.current_period_end` was REMOVED in Stripe's 2025-03-31.basil API (the version
 * lib/stripe.ts pins) and now lives on each subscription ITEM. lib/stripe-billing-cache read the
 * old field through an `as any` cast, so every cache write since the upgrade stored NULL, tsc had
 * nothing to object to, and the only symptom was a silence: the licences page hides its "Renews"
 * row behind `{currentPeriodEnd && …}`, so a paying garage was never told when it renews.
 *
 * A LEAF MODULE on purpose: `import type Stripe` is erased, so nothing here reaches lib/db or
 * lib/stripe, and a page may call it from either side of the bundle.
 *
 * THE EARLIEST ITEM, not items.data[0]. The question this answers is "when is money next taken",
 * and that is the earliest period to end — items.data[0] is merely the first one Stripe listed. On
 * a single-interval subscription they are identical, which is exactly why picking the wrong one
 * would never show. A disagreement is reported rather than hidden: see `renewalSpreadOf`.
 *
 * NO FALLBACK to the old top-level field. Carrying one would let a clause pass through the legacy
 * read and tell us the fix works when it does not — and the premise (the pinned Basil version in
 * lib/stripe.ts:45) is named here so the next person has the reasoning, not just the code.
 */
import type Stripe from 'stripe';

const unix = (s: number | null | undefined): Date | null => (s ? new Date(s * 1000) : null);

/** Every item's period end, as unix seconds, in the order Stripe listed them. Items with no period
 *  contribute nothing — absent is NOT zero, and a 1970 renewal date is worse than none. */
function itemPeriodEnds(sub: Stripe.Subscription): number[] {
  return (sub.items?.data ?? [])
    // NO CAST. SubscriptionItem.current_period_end is typed (and non-optional) in the Basil
    // types, so the compiler checks this read — the `as any` on the old top-level field is the
    // whole reason the removal went unnoticed. The runtime guard stays because a typed field is
    // not a present one: a hand-built fixture or a replayed older payload may carry nothing.
    .map((i) => i.current_period_end as number | null | undefined)
    .filter((s): s is number => typeof s === 'number' && s > 0);
}

/**
 * The next renewal (charge) date, or null when the subscription carries none — a subscription with
 * no items, or one whose items carry no period, is UNKNOWN, not "renews at the epoch".
 */
export function renewalAtOf(sub: Stripe.Subscription): Date | null {
  const ends = itemPeriodEnds(sub);
  return ends.length ? unix(Math.min(...ends)) : null;
}
