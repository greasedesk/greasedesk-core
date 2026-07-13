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
 *  2. tax_model === 'vat' is the ONLY implemented branch. sales_tax / gst_split are real values
 *     that THROW — US sales tax is thousands of destination jurisdictions, not a rate, and the
 *     flag exists so we fail loud at onboarding rather than tear apart a live ledger later.
 */

export type TaxModel = 'vat' | 'sales_tax' | 'gst_split';

export type TaxProfile = {
  countryCode: string;      // ISO 3166-1 alpha-2
  taxModel: TaxModel;
  taxName: string;          // Group.tax_label, relocated
  defaultRateBp: number;    // integer basis points; 2000 = 20%
  isRegistered: boolean;    // sub-threshold garage = false → no tax anywhere (a different invoice, not rate 0)
  taxNumber: string | null;
  pricesIncludeTax: boolean; // false for UK B2B (line prices are ex-tax)
};

export class NotImplementedTaxModel extends Error {
  constructor(model: string) { super(`Tax model '${model}' is not implemented (only 'vat').`); this.name = 'NotImplementedTaxModel'; }
}

/** bp → percent, the ONE conversion. 2000 → 20 (exact for whole and half percents). Kept as a
 *  separate step so the downstream arithmetic is byte-identical to the pre-refactor
 *  `round(base × ratePercent / 100)` — do not fold into a `× bp / 10000` (that changes the
 *  float division and can tip a round). */
export const bpToPercent = (bp: number): number => (Number.isFinite(bp) ? bp : 0) / 100;

/** Guard: the vat branch is the only live one. Called at every apply/gross-up entry. */
function assertVat(profile: { taxModel: TaxModel }): void {
  if (profile.taxModel !== 'vat') throw new NotImplementedTaxModel(profile.taxModel);
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
