/**
 * File: lib/locale-profiles.ts
 * THE Countries module. Everything that varies by country — currency, timezone options, tax model,
 * tax label, roadworthiness test name, date format — reads from ONE profile per country. Country is
 * the first onboarding question and it configures the rest of the flow; adding a country later is a
 * config entry here (+ optionally a public/locales/<code> file), never new per-step code.
 *
 * SUPPORTED today: GB, US, IE. Every other English-speaking country appears in the picker so a
 * visitor sees themselves listed, but selecting one lands on the coming-soon gate (supported=false).
 *
 * Country of record = Group.country_code (nullable; the first step writes it). tax_country_code /
 * tax_model / tax_label are DERIVED from the chosen profile, so price/label can't drift from country.
 */
export type TaxModel = 'vat' | 'sales_tax' | 'none';

export type CountryProfile = {
  countryCode: string;               // ISO 3166-1 alpha-2
  name: string;
  currency: string;                  // ISO 4217
  currencySymbol: string;            // for the labour-rate field etc. (Intl still formats money)
  locale: string;                    // BCP-47
  timezones: string[];               // the zones offered for this country
  defaultTimezone: string;
  taxModel: TaxModel;                // 'vat' (UK/IE) | 'sales_tax' (US) | 'none'
  taxLabel: string;                  // VAT / Sales Tax — what invoices are labelled
  /** GreaseDesk's OWN subscription price for this country, per site per month, EXCLUSIVE of tax —
   *  the settled ladder (2026-07-28): GB £75, US $100, IE €90. Display reads this via
   *  lib/billing-pricing; checkout must select a Stripe Price whose amount+currency MATCH it
   *  (verified at session creation — both halves or neither). */
  monthlyPrice: number;
  defaultTaxRatePercent: number;     // seeds the tax step (garage can change)
  requiresTaxNumber: boolean;        // VAT number asked (UK/IE) vs not (US flat rate)
  roadworthiness_test_name: string;  // MOT …
  date_format: string;
  modules: { hr: boolean };
  supported: boolean;
  /** Render a structured state/subdivision select at the site step (US-only today). The state
   *  narrows the timezone within `timezones` (lib/us-states) — it never widens it. */
  stateField?: boolean;
  // Back-compat alias for existing readers (resolveTenantProfile etc.).
  currencyCode?: string;
  tax_name?: string;
};

export const DEFAULT_COUNTRY = 'GB';

const P = (p: Omit<CountryProfile, 'currencyCode' | 'tax_name'>): CountryProfile => ({
  ...p, currencyCode: p.currency, tax_name: p.taxLabel,
});

/** SUPPORTED countries — full config. */
export const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  GB: P({
    countryCode: 'GB', name: 'United Kingdom', currency: 'GBP', currencySymbol: '£', locale: 'en-GB',
    timezones: ['Europe/London'], defaultTimezone: 'Europe/London',
    taxModel: 'vat', taxLabel: 'VAT', defaultTaxRatePercent: 20, requiresTaxNumber: true, monthlyPrice: 75,
    roadworthiness_test_name: 'MOT', date_format: 'dd/MM/yyyy', modules: { hr: true }, supported: true,
  }),
  IE: P({
    countryCode: 'IE', name: 'Ireland', currency: 'EUR', currencySymbol: '€', locale: 'en-IE',
    timezones: ['Europe/Dublin'], defaultTimezone: 'Europe/Dublin',
    taxModel: 'vat', taxLabel: 'VAT', defaultTaxRatePercent: 23, requiresTaxNumber: true, monthlyPrice: 90,
    roadworthiness_test_name: 'NCT', date_format: 'dd/MM/yyyy', modules: { hr: true }, supported: true,
  }),
  US: P({
    countryCode: 'US', name: 'United States', currency: 'USD', currencySymbol: '$', locale: 'en-US',
    timezones: [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
      'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
    ],
    defaultTimezone: 'America/New_York',
    // Flat garage-entered combined rate, like their till — no VAT number, no jurisdiction lookup.
    taxModel: 'sales_tax', taxLabel: 'Sales Tax', defaultTaxRatePercent: 0, requiresTaxNumber: false, monthlyPrice: 100,
    roadworthiness_test_name: 'Safety Inspection', date_format: 'MM/dd/yyyy', modules: { hr: true }, supported: true,
    stateField: true, // US garages pick a state; timezone derives from it (lib/us-states)
  }),
};

/** The full picker — every English-speaking country, so every visitor sees themselves. Supported
 *  ones resolve to a profile above; the rest land on the coming-soon gate. */
export const PICKER_COUNTRIES: Array<{ code: string; name: string; supported: boolean }> = [
  { code: 'GB', name: 'United Kingdom', supported: true },
  { code: 'US', name: 'United States', supported: true },
  { code: 'IE', name: 'Ireland', supported: true },
  { code: 'CA', name: 'Canada', supported: false },
  { code: 'AU', name: 'Australia', supported: false },
  { code: 'NZ', name: 'New Zealand', supported: false },
  { code: 'ZA', name: 'South Africa', supported: false },
  { code: 'IN', name: 'India', supported: false },
  { code: 'SG', name: 'Singapore', supported: false },
  { code: 'NG', name: 'Nigeria', supported: false },
  { code: 'JM', name: 'Jamaica', supported: false },
  { code: 'MT', name: 'Malta', supported: false },
];

export const isSupportedCountry = (code: string | null | undefined): boolean =>
  !!code && !!COUNTRY_PROFILES[code.toUpperCase()]?.supported;

/** Profile for an ISO code, falling back to GB (so every existing reader keeps working). */
export function getProfile(countryCode: string | null | undefined): CountryProfile {
  return COUNTRY_PROFILES[(countryCode || '').toUpperCase()] ?? COUNTRY_PROFILES[DEFAULT_COUNTRY];
}

/** Country of record: Group.country_code first, else the legacy ref prefix, else GB. */
export function countryFromGroup(group: { country_code?: string | null; ref?: string | null } | null | undefined): string {
  const c = group?.country_code?.toUpperCase();
  if (c && COUNTRY_PROFILES[c]) return c;
  return countryFromRef(group?.ref);
}

/** Legacy: derive ISO country from a tenant ref like "GB-GD42". Kept for callers not yet migrated. */
export function countryFromRef(ref: string | null | undefined): string {
  if (ref && ref.length >= 2) {
    const prefix = ref.slice(0, 2).toUpperCase();
    if (COUNTRY_PROFILES[prefix]) return prefix;
  }
  return DEFAULT_COUNTRY;
}

/** Resolve a tenant's full profile from its Group (country_code preferred, ref fallback). */
export function resolveTenantProfile(group: { country_code?: string | null; ref?: string | null } | null | undefined): CountryProfile {
  return getProfile(countryFromGroup(group));
}

// Back-compat type alias — older imports referenced LocaleProfile.
export type LocaleProfile = CountryProfile;
