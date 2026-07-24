/**
 * File: lib/onboarding-steps.ts
 * Locale-keyed onboarding question config (item-13) — the "pre-designed steps, reusable across
 * geographies" idea in the right place. A geography is a ROW here, not a rebuilt page. Seeded UK-only;
 * Ireland/others are later entries in TAX_QUESTIONS_BY_LOCALE, no new code.
 *
 * These are the TAX-step questions (country, VAT-registration, VAT number, rate) sourced from the
 * TaxProfile work. Each question is a PLAIN, SERIALISABLE object so the wizard page can pass the whole
 * list to the client as props — `appliesWhen` is a declarative rule ({field, equals}), never a
 * function, so it survives JSON. The first plank of SuperAdmin (8): console-editable step config.
 */
export type OnboardingFieldType = 'country' | 'boolean' | 'text' | 'percent';

/** Declarative visibility rule — this question shows only when answers[field] === equals. */
export type AppliesWhen = { field: string; equals: string | number | boolean };

export type OnboardingQuestion = {
  key: string;                 // stable id for the answer map
  question: string;            // label shown in the wizard
  field: string;               // the answer key it writes (the API maps it to columns)
  type: OnboardingFieldType;
  locale: string;              // ISO country this row belongs to (seeded 'GB')
  default?: string | boolean;  // pre-filled value
  appliesWhen?: AppliesWhen;   // conditional display (serialisable)
  help?: string;               // optional sub-label
};

/** THE registry. One array per locale. Add a locale = add a row, not a rebuild. */
// Country is now the FIRST onboarding step, so the tax step no longer asks it — it renders the
// question set for the country already chosen, forked by TAX MODEL:
//   VAT (GB, IE): registered? / number / rate  →  invoices labelled VAT
//   Sales tax (US): charge sales tax? / combined rate  →  labelled Sales Tax, NO tax number
// `vat_registered`/`vat_rate_percent` are reused as the generic "charges tax" + "rate" fields (the
// API maps them the same way), so the fork is pure config, not a second write path.
export const TAX_QUESTIONS_BY_LOCALE: Record<string, OnboardingQuestion[]> = {
  GB: [
    { key: 'vat_registered', question: 'Is your garage VAT-registered?', field: 'vat_registered', type: 'boolean', locale: 'GB', default: true },
    { key: 'vat_number', question: 'VAT number', field: 'vat_number', type: 'text', locale: 'GB', appliesWhen: { field: 'vat_registered', equals: true }, help: 'e.g. GB123456789' },
    { key: 'vat_rate', question: 'Standard VAT rate (%)', field: 'vat_rate_percent', type: 'percent', locale: 'GB', default: '20', appliesWhen: { field: 'vat_registered', equals: true } },
  ],
  IE: [
    { key: 'vat_registered', question: 'Is your garage VAT-registered?', field: 'vat_registered', type: 'boolean', locale: 'IE', default: true },
    { key: 'vat_number', question: 'VAT number', field: 'vat_number', type: 'text', locale: 'IE', appliesWhen: { field: 'vat_registered', equals: true }, help: 'e.g. IE1234567X' },
    { key: 'vat_rate', question: 'Standard VAT rate (%)', field: 'vat_rate_percent', type: 'percent', locale: 'IE', default: '23', appliesWhen: { field: 'vat_registered', equals: true } },
  ],
  US: [
    { key: 'charges_tax', question: 'Do you charge sales tax?', field: 'vat_registered', type: 'boolean', locale: 'US', default: true },
    { key: 'sales_tax_rate', question: 'Your combined sales tax rate (%)', field: 'vat_rate_percent', type: 'percent', locale: 'US', default: '0', appliesWhen: { field: 'vat_registered', equals: true }, help: 'The total rate you charge at the till — state + local. No lookup; enter your own rate.' },
  ],
};

/** Countries offered at the country step (seeded UK-first; expand alongside the locale rows). */
export const ONBOARDING_COUNTRIES: Array<{ code: string; label: string }> = [
  { code: 'GB', label: 'United Kingdom' },
];

export function taxQuestionsForLocale(locale: string | null | undefined): OnboardingQuestion[] {
  return TAX_QUESTIONS_BY_LOCALE[(locale || 'GB').toUpperCase()] ?? TAX_QUESTIONS_BY_LOCALE.GB;
}
