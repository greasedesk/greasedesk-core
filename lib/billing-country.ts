/**
 * File: lib/billing-country.ts
 * THE tenant's country as Stripe should see it, and the one comparison that notices when Stripe
 * sees something else. Pure — no prisma, no Stripe — so the checkout path, the webhook and the
 * tests read one rule.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * We never used to send a country. Checkout invented one from the payer's browser/IP, falling back
 * to our own Stripe account's country, which is British — so ZZUS Motors, a US tenant, was recorded
 * as "35203, United Kingdom": an Alabama ZIP under a GB country, because the checkout was completed
 * from a UK connection. The tenant was right in GreaseDesk throughout; nothing carried it across.
 *
 * That is not a tidiness problem. Stripe Tax picks the tax REGIME from the customer's country, so a
 * US customer marked GB computes UK VAT rather than US sales tax the moment automatic_tax turns on.
 * And the failure is systematic in the direction that matters: reseller-assisted onboarding means
 * the person at the keyboard is routinely in a different country from the business being signed up.
 *
 * We already resolve the country to derive the currency. Sending it too costs nothing.
 *
 * ── THE PAYER STILL WINS, DELIBERATELY ──────────────────────────────────────────────────────────
 * Checkout prefills the address form from the customer we create, so the country we send is what a
 * payer SEES. With customer_update.address = 'auto' they can still change it, and they should be
 * able to — they may know better than our record. This module's job is to make our answer the
 * starting point rather than a guess, and to NOTICE when the two end up disagreeing.
 */

export type CountryMismatch = {
  groupCountry: string;   // what GreaseDesk holds (Group.country_code)
  stripeCountry: string;  // what Stripe holds on the customer
};

const norm = (c: string | null | undefined): string => String(c ?? '').trim().toUpperCase();

/**
 * NULL = nothing to report. A mismatch needs BOTH sides present: an absent Stripe country is a
 * customer who has not entered one yet (or a payment method that never asked), not a contradiction,
 * and reporting it would train us to ignore this.
 */
export function countryMismatch(groupCountry: string | null | undefined, stripeCountry: string | null | undefined): CountryMismatch | null {
  const g = norm(groupCountry);
  const s = norm(stripeCountry);
  if (!g || !s) return null;
  if (g === s) return null;
  return { groupCountry: g, stripeCountry: s };
}
