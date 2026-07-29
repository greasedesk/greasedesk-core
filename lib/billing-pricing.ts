/**
 * File: lib/billing-pricing.ts
 * THE single source of GreaseDesk's OWN subscription price strings + VAT status (item-12). Every
 * shipped price string routes through here, never a hardcoded figure.
 *
 * COUNTRY-AWARE (ruling 2026-07-28): the amount lives on the COUNTRY PROFILE (lib/locale-profiles
 * `monthlyPrice` — GB £75, US $100, IE €90, exclusive of tax). Tenant-scoped surfaces (dashboard
 * banner, licences, onboarding billing step) use the *For(profile) helpers; the PUBLIC marketing
 * site is GB-targeted and keeps the no-arg wrappers (GB profile).
 *
 * ⚠️ STRIPE ALIGNMENT: these are DISPLAYED prices. The actual charge is the Stripe Price selected
 * by currency (lib/stripe stripePriceIdForCurrency) — and checkout VERIFIES amount + currency
 * against the profile before creating a session, so display and charge cannot disagree (both
 * halves or neither; the £35-Price / £75-display drift can never recur silently).
 *
 * WHEN VAT REGISTRATION COMPLETES: flip GARAGE_VAT_REGISTERED to true. VAT-model countries (GB/IE)
 * gain " + VAT" labels AND Stripe Tax at Checkout. US labels never carry a VAT suffix.
 */
import { CountryProfile, getProfile, DEFAULT_COUNTRY } from '@/lib/locale-profiles';

// GreaseDesk Ltd's VAT status. Registration in progress (2026-07-14) — false until it lands.
export const GARAGE_VAT_REGISTERED = false;

/** Legacy GB constant — marketing schema/Seo only. Tenant surfaces use the profile helpers. */
export const MONTHLY_PRICE_POUNDS = getProfile(DEFAULT_COUNTRY).monthlyPrice;

const taxSuffix = (profile: CountryProfile): string =>
  GARAGE_VAT_REGISTERED && profile.taxModel === 'vat' ? ' + VAT' : '';

/** "£75" / "$100" / "€90" — one site, with " + VAT" only for registered VAT-model countries. */
export function perLocationLabelFor(profile: CountryProfile): string {
  return `${profile.currencySymbol}${profile.monthlyPrice}${taxSuffix(profile)}`;
}

/** "£225" (× site count) etc. */
export function monthlyPriceLabelFor(profile: CountryProfile, sites = 1): string {
  return `${profile.currencySymbol}${profile.monthlyPrice * Math.max(1, sites)}${taxSuffix(profile)}`;
}

/** GB wrappers for the public marketing site (and any legacy caller) — UK-published pricing. */
export function perLocationLabel(): string {
  return perLocationLabelFor(getProfile(DEFAULT_COUNTRY));
}
export function monthlyPriceLabel(sites = 1): string {
  return monthlyPriceLabelFor(getProfile(DEFAULT_COUNTRY), sites);
}
