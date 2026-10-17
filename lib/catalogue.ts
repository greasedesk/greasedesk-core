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
 * Returned in POUNDS (2dp) for the Decimal columns. unit_cost is NULL when the service has NO
 * components — the parts cost is NOT ENTERED (uncosted, flagged), distinct from a service whose
 * components sum to £0 (known-free). A number where genuinely known; null where not.
 */
export function fixedMirror(basePriceExVat: number, components: ComponentInput[]): { unitPricePounds: number; unitCostPounds: number | null } {
  const base = Number.isFinite(basePriceExVat) ? basePriceExVat : 0;
  return {
    unitPricePounds: Number(base.toFixed(2)),
    unitCostPounds: (components && components.length) ? penniesToPounds(componentCostPennies(components)) : null,
  };
}

/**
 * The TierAvailability values, as a LOCAL union rather than the Prisma enum.
 *
 * lib/catalogue is imported by EstimateBuilder, which is a client component, and a value import
 * from @prisma/client at module scope is how this codebase has shipped lib/db to the browser
 * before. A hand-written union has the opposite failure — it drifts from the database silently —
 * so catalogue-sets-gate asserts these are exactly the enum's values, in the DMMF, every run. The
 * gate is the part that makes the duplication safe; without it this is a copy waiting to rot.
 */
export const TIER_AVAILABILITIES = ['priced', 'per_job', 'not_applicable'] as const;
export type TierAvailabilityName = (typeof TIER_AVAILABILITIES)[number];

/**
 * ── WHAT A SERVICE COSTS AT A TIER, IN FOUR STATES ──────────────────────────────────────────────
 *
 *   no row for the tier (or no tier)   `base`            inherit base_price_ex_vat
 *   row, availability `priced`         `priced`          that price
 *   row, availability `per_job`        `per_job`         offered, priced on the day
 *   row, availability `not_applicable` `not_applicable`  NOT OFFERED to this tier at all
 *
 * ── WHY A UNION AND NOT ANOTHER FLAG ───────────────────────────────────────────────────────────
 * This returned `{ pricePounds, manual }` — two states for a question that has four. Adding
 * `offered: false` beside them would have produced an object that passes every existing `if`: a
 * caller reading `pricePounds` and `manual` would price a not-applicable service at "manual" and
 * put it on a customer's quote, with nothing to say it had gone wrong. That is the shape of
 * `{ withheld: true }` — truthy, field-compatible, silently wrong.
 *
 * So the branches do not share a field list. `not_applicable` carries no `pricePounds` at all, and
 * a caller that forgets it stops compiling rather than stops being right. There was exactly one
 * caller when this changed, which is the cheapest this will ever be.
 *
 * NOT a fifth state for "price is zero": 0 is a legitimately free service and is `priced`. The
 * null/zero discipline is the same one CatalogueItem.unit_cost carries.
 */
export type TierResolution =
  | { state: 'base'; pricePounds: number }
  | { state: 'priced'; pricePounds: number }
  | { state: 'per_job' }
  | { state: 'not_applicable' };

/** Is this service on offer to this tier at all? The one question the ladder builder asks. */
export const tierOffers = (r: TierResolution): boolean => r.state !== 'not_applicable';

/** The price to put on a line, or null when nobody can say yet. `not_applicable` has no price and
 *  is not a blank one — call tierOffers FIRST; this returns null for it so a careless caller gets
 *  an empty field rather than a number that was never true. */
export const tierPricePounds = (r: TierResolution): number | null =>
  r.state === 'base' || r.state === 'priced' ? r.pricePounds : null;

export function resolveTierPrice(
  basePriceExVat: number,
  tierPrices: Array<{ tierId: string; priceExVat: number | null; availability?: TierAvailabilityName | null }>,
  tierId: string | null,
): TierResolution {
  if (tierId) {
    const row = (tierPrices || []).find((t) => t.tierId === tierId);
    if (row) {
      // AVAILABILITY DECIDES, and the price is read only once it has. A row that predates the
      // column reads as null here; it is resolved the way it always was — a figure is a price, an
      // absent figure is per-job — which is exactly what the migration backfilled the stored rows
      // to. The fallback is for a client that has not been regenerated, not for live data.
      const a = row.availability ?? (row.priceExVat === null || row.priceExVat === undefined ? 'per_job' : 'priced');
      if (a === 'not_applicable') return { state: 'not_applicable' };
      if (a === 'per_job') return { state: 'per_job' };
      if (row.priceExVat === null || row.priceExVat === undefined) return { state: 'per_job' };
      return { state: 'priced', pricePounds: Number(row.priceExVat) };
    }
  }
  return { state: 'base', pricePounds: Number(basePriceExVat || 0) };
}

/**
 * The customer-facing line text for a fixed-price service: Title (heading) + Description (spec),
 * deduped when they're identical. Components are INTERNAL cost-only and NEVER appear here — this is
 * the one place that decides the printed spec, so the card-add path and any data re-derive can't
 * drift. Falls back to code only if both title and description are blank.
 */
export function fixedLineText(title: string | null | undefined, description: string | null | undefined, code?: string | null): string {
  const spec = (description || '').trim();
  const head = (title || '').trim();
  if (head && head !== spec) return spec ? `${head}\n${spec}` : head;
  return spec || head || (code || '').trim();
}
