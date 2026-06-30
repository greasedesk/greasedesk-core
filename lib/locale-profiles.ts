/**
 * File: lib/locale-profiles.ts
 * THE single country → locale/commercial-profile map. Everything that varies by country —
 * currency, locale, tax name (VAT/TVA/MwSt), roadworthiness test name (MOT/TÜV), date format,
 * enabled modules — reads from here. No scattered country checks anywhere else.
 *
 * Adding a country later = add ONE entry below (+ a public/locales/<code> file). No rebuild.
 *
 * Country is resolved in ONE place (resolveTenantProfile) from the tenant ref prefix today
 * (e.g. "GB-GD42" → "GB"). When a real field lands (Group.country_code), change ONLY the
 * internals of countryFromRef — every caller stays the same.
 */
export type LocaleProfile = {
  countryCode: string;
  currency: string;                 // ISO 4217
  locale: string;                   // BCP-47
  tax_name: string;                 // VAT / TVA / MwSt …
  roadworthiness_test_name: string; // MOT / TÜV …
  date_format: string;
  modules: { hr: boolean };
};

export const DEFAULT_COUNTRY = 'GB';

// Only GB is populated for now (single-market launch).
export const COUNTRY_PROFILES: Record<string, LocaleProfile> = {
  GB: {
    countryCode: 'GB',
    currency: 'GBP',
    locale: 'en-GB',
    tax_name: 'VAT',
    roadworthiness_test_name: 'MOT',
    date_format: 'dd/MM/yyyy',
    modules: { hr: true },
  },
};

/** Profile for an ISO country code, falling back to GB. */
export function getProfile(countryCode: string | null | undefined): LocaleProfile {
  return COUNTRY_PROFILES[(countryCode || '').toUpperCase()] ?? COUNTRY_PROFILES[DEFAULT_COUNTRY];
}

/**
 * Derive the ISO country from a tenant ref like "GB-GD42". THE ONLY place country is read.
 * Swap this body for a Group.country_code lookup when that field exists — callers unaffected.
 */
export function countryFromRef(ref: string | null | undefined): string {
  if (ref && ref.length >= 2) {
    const prefix = ref.slice(0, 2).toUpperCase();
    if (COUNTRY_PROFILES[prefix]) return prefix;
  }
  return DEFAULT_COUNTRY;
}

/** Resolve a tenant's full locale-profile from its Group (anything carrying a `ref`). */
export function resolveTenantProfile(group: { ref?: string | null } | null | undefined): LocaleProfile {
  return getProfile(countryFromRef(group?.ref));
}
