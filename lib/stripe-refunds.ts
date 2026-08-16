/**
 * File: lib/stripe-refunds.ts
 * THE one place refunds are read from Stripe.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 * Two call sites independently did `charge.refunds?.data ?? []` on a webhook event body. Stripe has
 * not included `refunds` on the Charge object by default since API version 2022-11-15 — it is a
 * paginated list that must be expanded or fetched. So both read an empty array, for ever, silently:
 *
 *   • lib/card-payment-fulfil  → no Refund row was ever written for a customer's card refund
 *   • lib/commission-billing   → a rep kept commission on subscription money we gave back
 *
 * Neither was noticed until a real £50 refund on 16 Aug 2026 produced a delivered webhook and zero
 * rows. The lesson is not "remember to expand": it is that reading a LIST off an event body is the
 * mistake, and the fix is a reader both sides share so the pair cannot drift apart again.
 *
 * ── THE EVENT BODY IS A NOTIFICATION, NOT A RECORD ──────────────────────────────────────────────
 * Scalars and ID strings on the object are dependable. Lists are not. This asks Stripe.
 *
 * ── ACCOUNT SCOPE IS PART OF THE QUESTION ───────────────────────────────────────────────────────
 * A garage's card refund lives on the CONNECTED account and needs `stripeAccount`; a subscription
 * refund is our own and must NOT carry one, or Stripe looks in the wrong place and truthfully
 * reports nothing. `accountId` is therefore explicit at every call — never defaulted, never guessed.
 */
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';

/** Only what a caller needs. Deliberately not the whole Stripe object — nothing should grow a habit. */
export type RefundLite = {
  id: string;            // re_…
  amount: number;        // pennies, positive
  currency: string;      // upper-cased
  reason: string | null;
  created: Date;
  status: string | null; // 'succeeded' | 'pending' | 'failed' | 'canceled'
};

/** Stripe pages at 100. A charge with more than that is not a real shape, but the loop is honest. */
const PAGE = 100;
const MAX_PAGES = 20;

export class StripeReadError extends Error {
  readonly code = 'STRIPE_READ_UNAVAILABLE';
  constructor(message: string) { super(message); this.name = 'StripeReadError'; }
}

/**
 * Every refund on a charge, from Stripe.
 *
 * THROWS when there is no Stripe client. That is deliberate and it matters: returning an empty list
 * because we could not ask is indistinguishable from "there are no refunds", and it is exactly the
 * shape of the bug this file replaces. A caller inside a webhook should let this propagate so the
 * event is retried — an unanswered question must go red, never quietly resolve to nothing.
 */
export async function listChargeRefunds(
  chargeId: string,
  opts: { accountId?: string | null } = {},
): Promise<RefundLite[]> {
  const stripe = getStripe();
  if (!stripe) throw new StripeReadError(`cannot list refunds for ${chargeId}: no Stripe client configured`);
  const req = opts.accountId ? { stripeAccount: opts.accountId } : undefined;

  const out: RefundLite[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: Stripe.ApiList<Stripe.Refund> = await stripe.refunds.list(
      { charge: chargeId, limit: PAGE, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      req,
    );
    for (const r of res.data) {
      out.push({
        id: r.id,
        amount: r.amount ?? 0,
        currency: String(r.currency ?? 'gbp').toUpperCase(),
        reason: r.reason ?? null,
        created: new Date((r.created ?? 0) * 1000),
        status: r.status ?? null,
      });
    }
    if (!res.has_more || res.data.length === 0) return out;
    startingAfter = res.data[res.data.length - 1].id;
  }
  // Twenty pages is two thousand refunds on one charge. Reaching here means something is wrong, and
  // returning a truncated list as though it were complete is how an undercount becomes a payout.
  throw new StripeReadError(`refunds for ${chargeId} exceeded ${MAX_PAGES * PAGE} — refusing to return a partial list`);
}

/**
 * A refund that actually moved money. Stripe's `pending` becomes `succeeded` (or `failed`) later,
 * and counting a pending refund as returned would understate what the customer is owed until it
 * settles. `null` status is treated as counting: older refunds predate the field and did settle.
 */
export const refundCounts = (r: RefundLite): boolean => r.status === null || r.status === 'succeeded';
