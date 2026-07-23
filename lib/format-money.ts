/**
 * File: lib/format-money.ts
 * THE single money-formatting chokepoint for the whole app. Every money figure — quotes,
 * invoices, dashboard, reporting — MUST format through here so identical pennies render
 * identically everywhere. No hand-formatting and no hardcoded currency symbols anywhere else.
 *
 * Input is integer PENNIES (minor units); currency + locale come from the Site (Site.currency_code,
 * Site.locale) or a resolved locale-profile. Uses Intl.NumberFormat — currency- and locale-aware.
 */
export type MoneyFormatOpts = {
  currency?: string; // ISO 4217, e.g. 'GBP'
  locale?: string;   // BCP-47, e.g. 'en-GB'
  maximumFractionDigits?: number; // default 2; pass 0 for whole-unit display (e.g. chart labels)
};

const DEFAULT_CURRENCY = 'GBP';
const DEFAULT_LOCALE = 'en-GB';

/**
 * Format integer pennies as a localized currency string.
 *   formatMoney(45000)                              → "£450.00"
 *   formatMoney(45000, { currency: 'EUR', locale: 'fr-FR' }) → "450,00 €"
 * Null/undefined/non-finite input is treated as 0 (never throws).
 */
export function formatMoney(pennies: number | null | undefined, opts: MoneyFormatOpts = {}): string {
  const currency = opts.currency || DEFAULT_CURRENCY;
  const locale = opts.locale || DEFAULT_LOCALE;
  const value = Number.isFinite(pennies as number) ? (pennies as number) / 100 : 0;
  const fmt: Intl.NumberFormatOptions = { style: 'currency', currency };
  if (opts.maximumFractionDigits != null) { fmt.maximumFractionDigits = opts.maximumFractionDigits; fmt.minimumFractionDigits = opts.maximumFractionDigits; }
  return new Intl.NumberFormat(locale, fmt).format(value);
}

/**
 * The tenant currency's bare SYMBOL — for field labels/units where a full amount would be wrong
 * (e.g. "Default Labour Rate (£/hr)" → "(€/hr)" for a EUR tenant). Same chokepoint, same source
 * (Site.currency_code / locale). GBP→£, EUR→€, USD/AUD→$ (narrow). Falls back to the code.
 */
export function currencySymbol(opts: MoneyFormatOpts = {}): string {
  const currency = opts.currency || DEFAULT_CURRENCY;
  const locale = opts.locale || DEFAULT_LOCALE;
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}
