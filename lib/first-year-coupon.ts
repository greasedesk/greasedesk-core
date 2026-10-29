/**
 * File: lib/first-year-coupon.ts
 * THE ONE PLACE THAT PUTS A FIRST-YEAR COUPON INTO STRIPE.
 *
 * The id and the spec are derived in lib/billing-plans (pure, no network). This is the half that
 * talks to Stripe: create it if it is not there, treat "it already exists" as the ordinary case,
 * and say so plainly when it genuinely fails.
 *
 * IT EXISTS BECAUSE THERE WERE ABOUT TO BE TWO COPIES. Checkout had this inline; change-plan now
 * needs the same thing when a garage switches to Yearly during its trial. Two copies is two places
 * for the "a failure must not quietly sell the offer at full price" rule to be forgotten — and the
 * forgetting would show up as a garage shown £450 and charged £750.
 *
 * RETURNS NULL ON FAILURE rather than throwing, because the two callers refuse differently: one
 * fails a Checkout session, the other a plan switch. Neither may proceed without the coupon.
 */
import type Stripe from 'stripe';
import { firstYearCouponId, firstYearCouponSpec } from '@/lib/billing-plans';

export async function ensureFirstYearCoupon(
  stripe: Stripe,
  discountPennies: number,
  currency: string,
): Promise<string | null> {
  // A ZERO DISCOUNT IS NOT A COUPON. Settings can legitimately leave no gap (offer and renewal
  // months were both 10 until 2026-10-26), and a £0 coupon is not something to send to Stripe.
  if (!Number.isInteger(discountPennies) || discountPennies <= 0) return null;
  const id = firstYearCouponId(discountPennies, currency);
  try {
    await stripe.coupons.create(firstYearCouponSpec(discountPennies, currency) as any);
  } catch (e: any) {
    // 409 is the ordinary case: the deterministic id means the same discount reuses one coupon.
    if (e?.code !== 'resource_already_exists') {
      console.error('[stripe] first-year coupon could not be created —', e?.message);
      return null;
    }
  }
  return id;
}
