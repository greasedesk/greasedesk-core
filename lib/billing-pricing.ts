/**
 * File: lib/billing-pricing.ts
 * THE single source of GreaseDesk's OWN subscription price + VAT status (item-12). GreaseDesk Ltd
 * is NOT VAT-registered yet, so the price is £35 FLAT — every shipped price string routes through
 * here, never a hardcoded "£35 + VAT".
 *
 * WHEN REGISTRATION COMPLETES: flip GARAGE_VAT_REGISTERED to true. That ONE change makes every
 * label read "+ VAT" AND turns Stripe Tax on at Checkout (pages/api/stripe/checkout reads this
 * flag). A config change, not a code change — one place, not six.
 */
export const MONTHLY_PRICE_POUNDS = 35;

// GreaseDesk Ltd's VAT status. Registration in progress (2026-07-14) — false until it lands.
export const GARAGE_VAT_REGISTERED = false;

const taxSuffix = (): string => (GARAGE_VAT_REGISTERED ? ' + VAT' : '');

/** "£35" (one location) or "£105" (× site count) — with " + VAT" only when registered. */
export function monthlyPriceLabel(sites = 1): string {
  return `£${MONTHLY_PRICE_POUNDS * Math.max(1, sites)}${taxSuffix()}`;
}

/** Per-single-location label: "£35" / "£35 + VAT". */
export function perLocationLabel(): string {
  return `£${MONTHLY_PRICE_POUNDS}${taxSuffix()}`;
}
