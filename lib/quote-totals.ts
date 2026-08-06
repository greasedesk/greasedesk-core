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
import { computeTax, taxOnBasePennies, exFromIncPennies } from '@/lib/tax';
import type { TaxApplyLine } from '@/lib/tax';

export type QuoteItemType = 'labour' | 'part' | 'misc' | 'fixed';

export type QuoteLineInput = {
  item_type: QuoteItemType;
  qty: number;                 // labour: hours; parts/misc: quantity. Floored at 0.
  unit_price_pennies: number;  // labour: hourly rate (floored at 0); parts/misc: unit price (NOT floored)
  unit_cost_pennies?: number | null; // number (incl 0) = known cost; NULL = cost UNKNOWN (excluded from margin, tallied as exposure)
  vatable: boolean;
};

export type QuoteLineResult = {
  line_total_pennies: number; // EX-VAT line net — what gets stored as the line total either way
  vat_pennies: number;        // line VAT (gross mode: the RESIDUAL, so ex + vat === the round gross)
  // The unit price to STORE (ex-VAT pennies). In ex mode = the input. In gross mode = the entered
  // GROSS unit price back-computed to ex, so nothing downstream (qty × unit_price, the freeze, the
  // invoice) has to know which mode created the line — they all keep seeing ex-VAT figures.
  unit_price_pennies: number;
};

export type QuoteTotals = {
  labour_pennies: number;        // sum of labour line totals (ex VAT)
  parts_pennies: number;         // sum of part + misc line totals (ex VAT) — misc folds into parts
  vat_pennies: number;           // VAT on VATable lines at vatRate
  total_pennies: number;         // labour + parts + vat
  labour_cost_pennies: number;   // sum of labour costs (margin reporting later)
  parts_cost_pennies: number;    // sum of part + misc costs — KNOWN costs only (null excluded)
  uncosted_parts_lines: number;  // count of part/misc lines with UNKNOWN (null) cost — the exposure
  uncosted_parts_pennies: number;// their line-total retail (ex VAT) — the exposure value
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

// null = cost UNKNOWN (excluded from the cost sum, tallied as exposure); a number (incl 0) = known.
function lineCostPennies(item: QuoteLineInput): number | null {
  if (item.unit_cost_pennies == null) return null;
  const qty = Math.max(0, nz(item.qty));
  const cost = Math.max(0, nz(item.unit_cost_pennies)); // cost floored at 0
  return Math.round(cost * qty);
}

export type QuoteTotalsOpts = {
  // Master switch (Group.vat_registered). When false, VAT is forced to 0 EVERYWHERE regardless of
  // per-line vatable flags — a non-registered garage charges/shows no VAT. Default true = VAT-as-now.
  // Gates at compute time only; stored line flags are untouched, so re-registering restores VAT.
  vatRegistered?: boolean;
  // GROSS-FIRST PRICING (Site.pricing_display_mode = 'inc_vat'). When true, each line's unit price is
  // read as VAT-INCLUSIVE: the garage types the total the customer pays and the ex-VAT + VAT fall out
  // of it. Per line the LINE GROSS (round(qty × gross-unit)) is the anchor; ex = exFromIncPennies,
  // and VAT = gross − ex (the RESIDUAL), so ex + vat === the round gross the customer sees — no
  // £99.99. The card VAT total is then the SUM of the residual line VATs (matching how the invoice
  // sums frozen per-line VAT), so the card total reconciles to the round gross exactly.
  // DEFAULT false — ex-VAT-first, byte-identical to before; existing tenants and June are untouched.
  grossEntry?: boolean;
};

export function computeQuoteTotals(items: QuoteLineInput[], rawVatRate: number, opts: QuoteTotalsOpts = {}): QuoteTotals {
  const vatApplies = opts.vatRegistered !== false; // default true (backward-compatible)
  const grossEntry = opts.grossEntry === true && vatApplies; // gross-first only bites when VAT applies
  const vat_rate = vatApplies ? clampVatRate(rawVatRate) : 0;
  // ALL tax arithmetic now routes through lib/tax (the one chokepoint). The gate is a lite profile
  // (taxModel+isRegistered) — the full TaxProfile is server-only; this stays pure/isomorphic.
  // rateBp = rate × 100: exact because a rate is Decimal(5,2) at most (never >2dp), so this is
  // byte-identical to the old `round(base × rate / 100)`.
  const profile = { taxModel: 'vat' as const, isRegistered: vatApplies };
  const rateBp = Math.round(vat_rate * 100);
  let labour = 0, parts = 0, labourCost = 0, partsCost = 0, uncostedLines = 0, uncostedPennies = 0;
  const lines: QuoteLineResult[] = [];
  const vatableLines: TaxApplyLine[] = [];

  let residualVat = 0; // gross mode: Σ per-line residual VAT — the authoritative card VAT in that mode
  for (const item of items) {
    // In gross mode a VATABLE line's entered unit price is VAT-INCLUSIVE. The line GROSS is the
    // anchor: ex = exFromIncPennies(gross), stored unit_price becomes the ex unit, VAT = gross − ex.
    // A non-VATable line has no VAT to strip, so gross === ex and it is identical in both modes.
    const rawTotal = lineTotalPennies(item); // in gross mode this is the GROSS line total
    let total: number;             // the EX-VAT line net to store + report
    let storedUnitPennies: number; // the EX unit price to persist
    let lineVat: number;

    if (grossEntry && item.vatable) {
      const lineGross = rawTotal;
      const lineEx = exFromIncPennies(profile, lineGross, rateBp);
      total = lineEx;
      lineVat = lineGross - lineEx;            // RESIDUAL — guarantees ex + vat === the round gross
      const qty = Math.max(0, nz(item.qty));
      storedUnitPennies = qty > 0 ? Math.round(lineEx / qty) : Math.max(0, nz(item.unit_price_pennies));
    } else {
      total = rawTotal;
      lineVat = taxOnBasePennies(profile, item.vatable ? total : 0, rateBp);
      storedUnitPennies = item.item_type === 'labour' ? Math.max(0, nz(item.unit_price_pennies)) : nz(item.unit_price_pennies);
    }

    const cost = lineCostPennies(item); // null = cost unknown
    if (item.item_type === 'labour') { labour += total; if (cost != null) labourCost += cost; }
    else { // part + misc both bucket into parts
      parts += total;
      if (cost == null) { uncostedLines += 1; uncostedPennies += total; } // UNKNOWN cost — never counted as 0
      else partsCost += cost;
    }
    if (item.vatable) vatableLines.push({ netPennies: total, rateBp, taxable: true });
    residualVat += lineVat;
    lines.push({ line_total_pennies: total, vat_pennies: lineVat, unit_price_pennies: storedUnitPennies });
  }

  // EX mode: authoritative VAT is sum-then-multiply, rounded once (computeTax groups by rate).
  // GROSS mode: authoritative VAT is the SUM of per-line residuals, so the card total reconciles to
  // the round grosses the customer sees (and to how the invoice sums frozen per-line VAT).
  const vat = grossEntry ? residualVat : computeTax(profile, vatableLines).taxPennies;

  return {
    labour_pennies: labour,
    parts_pennies: parts,
    vat_pennies: vat,
    total_pennies: labour + parts + vat,
    labour_cost_pennies: labourCost,
    parts_cost_pennies: partsCost,
    uncosted_parts_lines: uncostedLines,
    uncosted_parts_pennies: uncostedPennies,
    vat_rate,
    lines,
  };
}

// --- pennies <-> pounds (Decimal storage is pounds with 2dp) ---
export const poundsToPennies = (v: number | string | null | undefined): number =>
  Math.round(nz(typeof v === 'string' ? parseFloat(v) : (v ?? 0)) * 100);
export const penniesToPounds = (p: number): number => Math.round(nz(p)) / 100;
