/**
 * File: lib/tax.ts
 * THE one place a tax rate is applied (item-13 onboarding groundwork). Every quote, invoice line,
 * invoice document, AR figure and promo gross-up routes its tax arithmetic through here — three
 * implementations agreeing "by convention" is the ledger disease we are curing. PURE + isomorphic
 * (client live-preview + server persist import the same functions); getTaxProfile is the only
 * server-only piece (a DB read).
 *
 * TaxProfile: the Group is the LEGAL entity that files one tax return, so tax identity lives on
 * Group; currency + locale are TRADING identity and stay on Site. tax_name is Group.tax_label
 * RELOCATED (one value, seeded from locale_profiles at onboarding — never a third name source).
 * default_rate is integer BASIS POINTS (2000 = 20%) — the only tax value that is not already an
 * integer minor unit.
 *
 * TWO RULES that must never be "simplified":
 *  1. default_rate SEEDS NEW QUOTES ONLY. It is NEVER a live lookup for a historical invoice —
 *     an issued line's rate is frozen (InvoiceLine.vat_rate / Invoice.vat_registered_at_issue),
 *     same rule as labour_hours. The APPLY path (computeTax) uses the rate handed to it; the
 *     RENDER path (aggregateFrozenTax) SUMS the frozen per-line tax and re-derives NOTHING, so a
 *     tenant that later de-registers cannot retroactively move a customer's issued invoice.
 *  2. FLAT-RATE MODELS ONLY. `vat` and `sales_tax` are both a single rate applied to a base, so
 *     they share one implementation; `gst_split` THROWS, because a split rate is a different
 *     arithmetic and failing loud beats inventing one. The flag exists so an unimplemented regime
 *     fails at onboarding rather than tearing apart a live ledger later.
 *
 *     CORRECTED 2026-09-05: this said sales_tax threw, and it had not for some time — the code
 *     read `FLAT_RATE_MODELS = ['vat', 'sales_tax']` while the header told the next reader to plan
 *     around an exception that never fires. A file documenting a rule it does not enforce is worse
 *     than one documenting nothing.
 *
 *     WHAT IS STILL TRUE, and is the reason the old sentence was written: US sales tax is thousands
 *     of destination jurisdictions, not a rate. A flat rate is the garage's own combined figure,
 *     entered like the one on their till — it is a usable answer for a single-location shop and NOT
 *     a jurisdiction engine. Nothing here derives a rate from an address, and it must not start.
 */

import { PICKER_COUNTRIES } from '@/lib/locale-profiles';

export type TaxModel = 'vat' | 'sales_tax' | 'gst_split';

/**
 * Country CODE → the name a person reads. Built from PICKER_COUNTRIES, which already lists every
 * country the product offers (supported or not), so this cannot drift from the picker or acquire a
 * fourth spelling of "United Kingdom". An unknown code falls back to the code itself rather than to
 * a guess.
 */
const COUNTRY_NAMES: Record<string, string> =
  Object.fromEntries(PICKER_COUNTRIES.map((c) => [c.code, c.name]));

export type TaxProfile = {
  countryCode: string;      // ISO 3166-1 alpha-2
  taxModel: TaxModel;
  taxName: string;          // Group.tax_label, relocated
  defaultRateBp: number;    // integer basis points; 2000 = 20%
  isRegistered: boolean;    // sub-threshold garage = false → no tax anywhere (a different invoice, not rate 0)
  taxNumber: string | null;
  pricesIncludeTax: boolean; // false for UK B2B (line prices are ex-tax)
};

/**
 * ── TWO TAX FACTS, SAID AS TWO FACTS ────────────────────────────────────────────────────────────
 * `tax_model` is the REGIME a tenant's country runs; registration is that tenant's STATUS within
 * it. They are orthogonal, and rendering them as bare values put "VAT registration: Not registered"
 * directly beneath "Tax model: vat" — which reads as a contradiction and is not one. A sub-threshold
 * UK garage is exactly that, and it is the commonest state a small garage is in.
 *
 * Worse outside the UK: the registration row was the literal words "VAT registration" for every
 * tenant, so the one US garage in the database was shown as registered for a tax its country has no
 * concept of, with no number to show for it.
 *
 * SO BOTH ROWS COME FROM HERE, from the tenant's OWN tax word and its own country. Two rules:
 *   - never print the enum. `sales_tax` is a storage detail, not a sentence.
 *   - the unregistered case states its CONSEQUENCE, not its status. "Not registered" makes a reader
 *     ask what follows from that, and answering it is the only reason the row is on a screen.
 *
 * PURE, and deliberately taking a country CODE rather than a profile: the caller has a Group row,
 * and a shaper that demanded a resolved profile would push the same lookup into every call site.
 */
export type TaxDisplay = {
  regimeLabel: string; regimeValue: string;
  registrationLabel: string; registrationValue: string;
};

export function taxDisplay(t: {
  taxLabel?: string | null;
  countryCode?: string | null;
  isRegistered?: boolean | null;
}): TaxDisplay {
  // The tenant's own word for its tax, or the neutral fallback — never the enum.
  const label = (t.taxLabel ?? '').trim() || 'Tax';
  // HONEST-NULL ON THE COUNTRY. getProfile falls back to GB, which is right for BEHAVIOUR and wrong
  // for a LABEL: a tenant that has not reached the country step has not chosen one, and naming
  // "United Kingdom" beside their tax would assert something nobody decided.
  const code = (t.countryCode ?? '').trim();
  const country = code ? (COUNTRY_NAMES[code] ?? code) : null;
  return {
    regimeLabel: 'Tax regime',
    regimeValue: country ? `${label} (${country})` : label,
    registrationLabel: `Registered for ${label}`,
    // Asymmetric on purpose. "Registered" surprises nobody and needs no explanation; the other
    // answer is the one that changes what every document says, so it says so.
    registrationValue: t.isRegistered ? 'Yes' : `No — no ${label} is charged on any document`,
  };
}

export class NotImplementedTaxModel extends Error {
  constructor(model: string) { super(`Tax model '${model}' is not implemented (only 'vat').`); this.name = 'NotImplementedTaxModel'; }
}

/** bp → percent, the ONE conversion. 2000 → 20 (exact for whole and half percents). Kept as a
 *  separate step so the downstream arithmetic is byte-identical to the pre-refactor
 *  `round(base × ratePercent / 100)` — do not fold into a `× bp / 10000` (that changes the
 *  float division and can tip a round). */
export const bpToPercent = (bp: number): number => (Number.isFinite(bp) ? bp : 0) / 100;

/** Guard: FLAT-RATE tax models are live (vat, sales_tax) — both are 'a percentage of the base',
 *  so they share this arithmetic and differ only in LABEL + whether a tax number is asked. gst_split
 *  is genuinely different (input/output split) and still throws so we fail loud, not silently wrong. */
const FLAT_RATE_MODELS = new Set<TaxModel>(['vat', 'sales_tax']);
function assertVat(profile: { taxModel: TaxModel }): void {
  if (!FLAT_RATE_MODELS.has(profile.taxModel)) throw new NotImplementedTaxModel(profile.taxModel);
}

/** Tax on an ex-tax base, in pennies. THE single rate application. Gated by registration (an
 *  unregistered tenant yields 0 — no tax anywhere). Byte-identical to the old
 *  `round(net × rate / 100)`: bpToPercent(2000)=20 → round(base × 20 / 100). */
export function taxOnBasePennies(profile: { taxModel: TaxModel; isRegistered: boolean }, basePennies: number, rateBp: number): number {
  assertVat(profile);
  if (!profile.isRegistered) return 0;
  const pct = bpToPercent(rateBp);
  const clamped = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
  return Math.round((basePennies * clamped) / 100);
}

/** Ex-tax amount from a tax-inclusive amount (the promo gross-up). Byte-identical to the old
 *  `round(inc / (1 + rate/100))`. Unregistered → the inc amount IS the ex amount (no tax to strip). */
export function exFromIncPennies(profile: { taxModel: TaxModel; isRegistered: boolean }, incPennies: number, rateBp: number): number {
  assertVat(profile);
  if (!profile.isRegistered) return incPennies;
  const pct = bpToPercent(rateBp);
  return Math.round(incPennies / (1 + (pct || 0) / 100));
}

// ── The APPLY aggregate (quotes / freeze recompute) ──────────────────────────────────────────
export type TaxApplyLine = { netPennies: number; rateBp: number; taxable: boolean };
export type TaxResult = {
  breakdown: Array<{ rateBp: number; netPennies: number; taxPennies: number }>;
  netPennies: number; taxPennies: number; grossPennies: number;
};

/**
 * computeTax(profile, lines) — THE chokepoint for applying tax to a set of ex-tax lines.
 * Sum-then-multiply PER RATE, rounded once per rate group (matches the pre-refactor single-round).
 * Non-taxable lines contribute to net only. Registration gate + model branch enforced here.
 * NOTE: this is the APPLY path (a live quote, or the freeze recompute). For a rendered/AR invoice
 * use aggregateFrozenTax — the frozen line_vat is the truth and must not be re-derived (see rule 1).
 */
export function computeTax(profile: { taxModel: TaxModel; isRegistered: boolean }, lines: TaxApplyLine[]): TaxResult {
  assertVat(profile);
  const byRate = new Map<number, { rateBp: number; netPennies: number; taxableBase: number }>();
  let netP = 0;
  for (const l of lines) {
    const net = Math.round(l.netPennies || 0);
    netP += net;
    const g = byRate.get(l.rateBp) ?? { rateBp: l.rateBp, netPennies: 0, taxableBase: 0 };
    g.netPennies += net;
    if (l.taxable) g.taxableBase += net;
    byRate.set(l.rateBp, g);
  }
  let taxP = 0;
  const breakdown = Array.from(byRate.values())
    .map((g) => {
      const taxPennies = taxOnBasePennies(profile, g.taxableBase, g.rateBp); // sum-then-multiply, one round
      taxP += taxPennies;
      return { rateBp: g.rateBp, netPennies: g.netPennies, taxPennies };
    })
    .sort((a, b) => b.rateBp - a.rateBp);
  return { breakdown, netPennies: netP, taxPennies: taxP, grossPennies: netP + taxP };
}

// ── The RENDER/AR aggregate (frozen invoices) ────────────────────────────────────────────────
export type FrozenTaxLine = { rateBp: number; netPennies: number; taxPennies: number };

/**
 * aggregateFrozenTax(lines) — sums the FROZEN per-line net + tax for a rendered or AR invoice.
 * DELIBERATELY re-derives nothing: an issued invoice's tax was decided at freeze (rate +
 * registration snapshot) and is immutable — re-applying today's profile would let a later
 * de-registration silently move a customer's historical total. Same discipline as labour_hours.
 * No registration gate here for exactly that reason (the gate was applied at freeze).
 */
export function aggregateFrozenTax(lines: FrozenTaxLine[]): TaxResult {
  const byRate = new Map<string, { rateBp: number; netPennies: number; taxPennies: number }>();
  let netP = 0, taxP = 0;
  for (const l of lines) {
    netP += l.netPennies; taxP += l.taxPennies;
    const key = l.rateBp.toString();
    const b = byRate.get(key) ?? { rateBp: l.rateBp, netPennies: 0, taxPennies: 0 };
    b.netPennies += l.netPennies; b.taxPennies += l.taxPennies;
    byRate.set(key, b);
  }
  return {
    breakdown: Array.from(byRate.values()).sort((a, b) => b.rateBp - a.rateBp),
    netPennies: netP, taxPennies: taxP, grossPennies: netP + taxP,
  };
}
