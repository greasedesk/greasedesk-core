/**
 * File: lib/enabled-countries.ts
 * THE enabled-countries allow-list — the single server-side answer to "may a tenant be admitted in
 * this country today?". One list, defined here, read from here, nowhere else.
 *
 * A REFUSAL POINT, NOT A RESOLVER. It answers yes/no and never returns a country. The two existing
 * country readers deliberately FAIL OPEN — getProfile() falls back to GB for an unknown code and
 * countryFromRef() derives a country from the ref prefix — which is correct for RENDERING (an
 * existing tenant must always resolve to something) and wrong for ADMISSION. So nothing in this
 * module defaults, substitutes or coerces: an unrecognised code is refused, never quietly turned
 * into GB. If you find yourself wanting a fallback here, you want getProfile() instead.
 *
 * ENABLED is NOT CountryProfile.supported. `supported` means the product has a working profile for
 * a country — GB, US and IE all do, and everything built for them stays built and working (the
 * multi-currency Stripe Price, country-aware checkout, the US state field with timezone derivation,
 * the /ie document-resolution branch). ENABLED means we are open for business there. Today: GB only.
 * Opening a country is one edit to the array below; no other code changes.
 */
import { PICKER_COUNTRIES } from '@/lib/locale-profiles';

/** The allow-list. Adding a code here is the ONLY way to open a country. */
export const ENABLED_COUNTRIES: readonly string[] = ['GB'];

/**
 * Is this country open for new tenants? Boolean only — no country is ever returned, so this can
 * never become a third fail-open resolver. Null, undefined, unknown and disabled all answer false.
 */
export function isEnabledCountry(code: string | null | undefined): boolean {
  return typeof code === 'string' && ENABLED_COUNTRIES.includes(code.trim().toUpperCase());
}

/**
 * The picker's options — enabled countries only, so a country that would be refused is never
 * offered. Derived from the same array, so the screen and the server cannot disagree.
 */
export function enabledCountryOptions(): Array<{ code: string; name: string }> {
  return PICKER_COUNTRIES.filter((c) => isEnabledCountry(c.code)).map((c) => ({ code: c.code, name: c.name }));
}
