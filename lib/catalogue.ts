/**
 * File: lib/catalogue.ts
 * THE one place a fixed service's mirror (unit_price / unit_cost) is derived. Fixed items are
 * price-led (base_price_ex_vat) with cost from components (Σ qty × unit_cost); the legacy NOT-NULL
 * unit_price/unit_cost columns are MIRRORED from those so computeQuoteTotals + the invoice keep
 * working. Callers never set the mirror — the /api/catalogue write path re-runs this on every write
 * so it can't drift. Money in pennies internally (no float drift), pounds at the edges.
 */
import { poundsToPennies, penniesToPounds } from '@/lib/quote-totals';

export type ComponentInput = { description: string; qty: number; unitCostExVat: number };

/** Total component cost in pennies: Σ round(qty × unit_cost). qty/cost floored at 0. */
export function componentCostPennies(components: ComponentInput[]): number {
  return (components || []).reduce((sum, c) => {
    const qty = Math.max(0, Number.isFinite(c.qty) ? c.qty : 0);
    const cost = Math.max(0, poundsToPennies(c.unitCostExVat));
    return sum + Math.round((qty * cost) / 1); // qty is a multiplier, cost already in pennies
  }, 0);
}

/**
 * The mirror for a fixed item: unit_price = base price (anchor), unit_cost = component cost sum.
 * Returned in POUNDS (2dp) for the Decimal columns.
 */
export function fixedMirror(basePriceExVat: number, components: ComponentInput[]): { unitPricePounds: number; unitCostPounds: number } {
  const base = Number.isFinite(basePriceExVat) ? basePriceExVat : 0;
  return {
    unitPricePounds: Number(base.toFixed(2)),
    unitCostPounds: penniesToPounds(componentCostPennies(components)),
  };
}

/**
 * Resolve a fixed service's price for a chosen tier (pounds):
 *   tier row with a value → that price; tier row present with null → 'manual' (price on the day);
 *   no row for the tier (or no tier) → base_price.
 */
export type TierResolution = { pricePounds: number | null; manual: boolean };
export function resolveTierPrice(
  basePriceExVat: number,
  tierPrices: Array<{ tierId: string; priceExVat: number | null }>,
  tierId: string | null,
): TierResolution {
  if (tierId) {
    const row = (tierPrices || []).find((t) => t.tierId === tierId);
    if (row) {
      if (row.priceExVat === null || row.priceExVat === undefined) return { pricePounds: null, manual: true };
      return { pricePounds: Number(row.priceExVat), manual: false };
    }
  }
  return { pricePounds: Number(basePriceExVat || 0), manual: false };
}
