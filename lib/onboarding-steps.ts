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
export const TAX_QUESTIONS_BY_LOCALE: Record<string, OnboardingQuestion[]> = {
  GB: [
    { key: 'country', question: 'Country', field: 'tax_country_code', type: 'country', locale: 'GB', default: 'GB' },
    { key: 'vat_registered', question: 'Is your garage VAT-registered?', field: 'vat_registered', type: 'boolean', locale: 'GB', default: true },
    { key: 'vat_number', question: 'VAT number', field: 'vat_number', type: 'text', locale: 'GB', appliesWhen: { field: 'vat_registered', equals: true }, help: 'e.g. GB123456789' },
    { key: 'vat_rate', question: 'Standard VAT rate (%)', field: 'vat_rate_percent', type: 'percent', locale: 'GB', default: '20', appliesWhen: { field: 'vat_registered', equals: true } },
  ],
};

/** Countries offered at the country step (seeded UK-first; expand alongside the locale rows). */
export const ONBOARDING_COUNTRIES: Array<{ code: string; label: string }> = [
  { code: 'GB', label: 'United Kingdom' },
];

export function taxQuestionsForLocale(locale: string | null | undefined): OnboardingQuestion[] {
  return TAX_QUESTIONS_BY_LOCALE[(locale || 'GB').toUpperCase()] ?? TAX_QUESTIONS_BY_LOCALE.GB;
}
