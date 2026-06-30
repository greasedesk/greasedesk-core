/**
 * File: lib/quote-totals.ts
 * THE single source of truth for quote/estimate maths (ported from the WordPress GreaseDesk
 * plugin). Pure + isomorphic: the UI imports it for live preview, the API imports it to persist —
 * identical maths everywhere (per CLAUDE.md chokepoint discipline). The server recomputes on save
 * and NEVER trusts client-sent totals.
 *
 * All money is INTEGER PENNIES end-to-end (no float money errors). Storage converts pennies→Decimal
 * pounds (÷100) at the edge.
 *
 * Rules (deliberate):
 *  - labour line total = rate × hours;  parts/misc line total = price × qty.
 *  - Flooring is type-dependent: labour rate AND hours are floored at 0 (labour never negative);
 *    parts/misc qty is floored at 0 but PRICE is NOT floored — negative price = discount line.
 *  - Per-line VATable flag: only VATable lines contribute to VAT.
 *  - VAT = round( (sum of VATable line totals) × vatRate / 100 )  — sum-then-multiply, one rounding.
 */
export type QuoteItemType = 'labour' | 'part' | 'misc';

export type QuoteLineInput = {
  item_type: QuoteItemType;
  qty: number;                 // labour: hours; parts/misc: quantity. Floored at 0.
  unit_price_pennies: number;  // labour: hourly rate (floored at 0); parts/misc: unit price (NOT floored)
  unit_cost_pennies?: number;  // optional; floored at 0
  vatable: boolean;
};

export type QuoteLineResult = { line_total_pennies: number; vat_pennies: number };

export type QuoteTotals = {
  labour_pennies: number;        // sum of labour line totals (ex VAT)
  parts_pennies: number;         // sum of part + misc line totals (ex VAT) — misc folds into parts
  vat_pennies: number;           // VAT on VATable lines at vatRate
  total_pennies: number;         // labour + parts + vat
  labour_cost_pennies: number;   // sum of labour costs (margin reporting later)
  parts_cost_pennies: number;    // sum of part + misc costs
  vat_rate: number;              // the clamped rate actually used
  lines: QuoteLineResult[];      // per-line, index-aligned with the input
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const nz = (n: number) => (Number.isFinite(n) ? n : 0);

export function clampVatRate(rate: number): number {
  return clamp(nz(rate), 0, 100);
}

/** Single line total in pennies, applying the type-dependent flooring rules. */
function lineTotalPennies(item: QuoteLineInput): number {
  const qty = Math.max(0, nz(item.qty)); // hours / quantity never negative
  if (item.item_type === 'labour') {
    const rate = Math.max(0, nz(item.unit_price_pennies)); // labour rate never negative
    return Math.round(rate * qty);
  }
  // parts / misc: price may be negative (discount line)
  return Math.round(nz(item.unit_price_pennies) * qty);
}

function lineCostPennies(item: QuoteLineInput): number {
  const qty = Math.max(0, nz(item.qty));
  const cost = Math.max(0, nz(item.unit_cost_pennies ?? 0)); // cost floored at 0
  return Math.round(cost * qty);
}

export function computeQuoteTotals(items: QuoteLineInput[], rawVatRate: number): QuoteTotals {
  const vat_rate = clampVatRate(rawVatRate);
  let labour = 0, parts = 0, labourCost = 0, partsCost = 0, vatableBase = 0;
  const lines: QuoteLineResult[] = [];

  for (const item of items) {
    const total = lineTotalPennies(item);
    const cost = lineCostPennies(item);
    if (item.item_type === 'labour') { labour += total; labourCost += cost; }
    else { parts += total; partsCost += cost; } // part + misc both bucket into parts
    if (item.vatable) vatableBase += total;
    // Per-line VAT is informational (record only); the card VAT below is the authoritative figure.
    lines.push({ line_total_pennies: total, vat_pennies: item.vatable ? Math.round((total * vat_rate) / 100) : 0 });
  }

  // Authoritative VAT: sum-then-multiply, rounded once.
  const vat = Math.round((vatableBase * vat_rate) / 100);

  return {
    labour_pennies: labour,
    parts_pennies: parts,
    vat_pennies: vat,
    total_pennies: labour + parts + vat,
    labour_cost_pennies: labourCost,
    parts_cost_pennies: partsCost,
    vat_rate,
    lines,
  };
}

// --- pennies <-> pounds (Decimal storage is pounds with 2dp) ---
export const poundsToPennies = (v: number | string | null | undefined): number =>
  Math.round(nz(typeof v === 'string' ? parseFloat(v) : (v ?? 0)) * 100);
export const penniesToPounds = (p: number): number => Math.round(nz(p)) / 100;
