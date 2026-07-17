/**
 * File: lib/billing-pricing.ts
 * THE single source of GreaseDesk's OWN subscription price + VAT status (item-12). GreaseDesk Ltd
 * is NOT VAT-registered yet, so the price is £75 FLAT — every shipped price string routes through
 * here, never a hardcoded "£75 + VAT".
 *
 * ⚠️ STRIPE ALIGNMENT (2026-07-17): this constant is the DISPLAYED price. The actual charge is the
 * Stripe PRICE ID (pages/api/stripe/checkout → stripePriceId()), set in the Stripe dashboard/env —
 * NOT this number. Keep them equal: the Stripe Price must be £75 or checkout shows one figure and
 * charges another. (Trial is 60 days, so there's a window, but align before any trial converts.)
 *
 * WHEN VAT REGISTRATION COMPLETES: flip GARAGE_VAT_REGISTERED to true. That ONE change makes every
 * label read "+ VAT" AND turns Stripe Tax on at Checkout. A config change, not a code change.
 */
export const MONTHLY_PRICE_POUNDS = 75;

// GreaseDesk Ltd's VAT status. Registration in progress (2026-07-14) — false until it lands.
export const GARAGE_VAT_REGISTERED = false;

const taxSuffix = (): string => (GARAGE_VAT_REGISTERED ? ' + VAT' : '');

/** "£75" (one location) or "£225" (× site count) — with " + VAT" only when registered. */
export function monthlyPriceLabel(sites = 1): string {
  return `£${MONTHLY_PRICE_POUNDS * Math.max(1, sites)}${taxSuffix()}`;
}

/** Per-single-location label: "£75" / "£75 + VAT". */
export function perLocationLabel(): string {
  return `£${MONTHLY_PRICE_POUNDS}${taxSuffix()}`;
}
