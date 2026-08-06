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
 * ⚠️ STRIPE ALIGNMENT: these are DISPLAYED prices. The actual charge is the ONE multi-currency
 * Stripe Price (STRIPE_PRICE_ID, GBP base + currency_options) — checkout passes the profile's
 * currency on the session and VERIFIES the option's amount against the profile first, so display
 * and charge cannot disagree (both halves or neither; the £35 drift can never recur silently).
 *
 * WHEN VAT REGISTRATION COMPLETES: set NEXT_PUBLIC_GARAGE_VAT_REGISTERED=true in Vercel. VAT-model
 * countries (GB/IE) gain " + VAT" labels AND Stripe Tax at Checkout. US labels never carry a VAT
 * suffix.
 *
 * ── WHY AN ENV VAR, AND WHY NEXT_PUBLIC ─────────────────────────────────────────────────────────
 * Registration completes on a date HMRC picks, not on a date we ship. As a hardcoded constant the
 * flip needed a code change, a review and a deploy; as an env var it is a one-line change in Vercel
 * and a redeploy of the SAME code, revertible in seconds. (Vercel env changes do require a
 * redeploy to take effect — the win is that no code changes, not that it is instant.)
 *
 * NEXT_PUBLIC deliberately: this flag is read on BOTH sides — server-side at Checkout, and inside
 * components/marketing/Seo, which ships in the client bundle. A server-only variable would be
 * `undefined` in that bundle, so the JSON-LD would say one thing and the server another, and the
 * two would disagree the moment the flag flipped. It is not a secret: whether our prices include
 * VAT is already published in the marketing schema.
 */
import { CountryProfile, getProfile, DEFAULT_COUNTRY } from '@/lib/locale-profiles';

/**
 * GreaseDesk Ltd's VAT status. DEFAULTS FALSE — only the exact string 'true' turns it on, so a
 * typo, a blank, or an unset variable all leave us unregistered, which is the safe direction: the
 * failure mode of a wrong `true` is charging VAT we cannot account for.
 *
 * A function, not a const, so it is read where it is used rather than frozen at module load.
 */
export const garageVatRegistered = (): boolean => process.env.NEXT_PUBLIC_GARAGE_VAT_REGISTERED === 'true';

/** Legacy GB constant — marketing schema/Seo only. Tenant surfaces use the profile helpers. */
export const MONTHLY_PRICE_POUNDS = getProfile(DEFAULT_COUNTRY).monthlyPrice;

const taxSuffix = (profile: CountryProfile): string =>
  garageVatRegistered() && profile.taxModel === 'vat' ? ' + VAT' : '';

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
