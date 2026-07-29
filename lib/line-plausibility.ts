/**
 * File: lib/line-plausibility.ts
 * Parts-line entry-error heuristics (investigation 2026-07-26 — the £4,874.85 "price typed into the
 * quantity field" case). PURE and shared, so the inline card warning and the pre-issue summary name
 * the same suspicion the same way. ADVISORY ONLY — nothing here ever blocks a save or an issue.
 *
 * Approved rule set (D dropped — it flagged every zero-cost service, a false-positive flood):
 *   B — unit price is exactly £1.00 AND qty > 1  → a £ amount typed into the quantity field. This is
 *       the precise signal and it carries a DETERMINISTIC fix: qty → 1, unit price → the old quantity
 *       (retail = qty × £1.00 is preserved to the penny). Non-labour only.
 *   A — a fractional (non-integer) quantity greater than 10 on a part → parts are whole numbers, so a
 *       "12.50" part is suspect. WARN ONLY (no deterministic fix). Non-labour only.
 *   C — line cost STRICTLY exceeds line retail → the line loses money. WARN ONLY. Non-labour only.
 *
 * Labour is excluded from A, B, C and E: fractional hours (0.5, 2.5, 5.45) are legitimate and the
 * qty→1 fix is meaningless for time. On one line, B takes precedence over A (B is precise + fixable);
 * C is independent and may co-fire with either.
 *
 * ── LABOUR RULES (investigation 2026-07-29 — the 99.5 phantom hours) ──────────────────────────────
 * Two TMBS invoices carried MONEY typed into the hours box: `75 × £1.00` to replace a bonnet catch,
 * and `12 × £1.00` twice on a £30 invoice. Hours drive capacity, utilisation and the sold-hours
 * valuation, so the error corrupted every derived figure. The quantity tests above cannot help
 * (any hours figure is arithmetically legal), but the UNIT PRICE can: a garage does not sell labour
 * at £1/hr against a £75 posted rate.
 *
 *   L1 — unit price ≤ 5% of the posted rate. The £1-per-hour signature, at any quantity.
 *   L2 — unit price ≤ 25% of posted AND hours ≥ 8. Catches the same typo at prices L1 misses
 *        (e.g. `30 × £5`); the HOURS FLOOR is what makes 25% safe.
 *
 * THRESHOLDS ARE DERIVED FROM THE DATA, not chosen: across all 133 labour lines in the live tenant,
 * 113 sit at exactly the posted rate, 9 at £0, and the only reduced rates are £45.83, £40, £12 and
 * £8 — with NOTHING between £0 and £8. 5% (£3.75 on a £75 rate) sits inside that gap. A flat 25%
 * rule was REJECTED: it flagged all four legitimate £8/hr apprentice lines and nothing else.
 * The reduced-rate lines are all ≤ 4h, so the 8h floor clears the largest by 2×.
 *
 * NO ONE-CLICK FIX, deliberately. B's fix is exact because a part's retail is qty × £1.00. For
 * labour the MONEY is recoverable but the HOURS are not: `75 × £1` might have been 1h at £75 or
 * 1.5h at £50. Hours are the figure that broke, so inventing one to tidy the arithmetic would be
 * fabrication. The message names the likely reading and asks for the real hours.
 *
 * ACCEPTED TRADE (stated, not overlooked): a genuine 10-hour job at £8/hr WILL warn. A long line at
 * 11% of rate is worth a second glance, and the warning is advisory.
 *
 * UNCONFIGURED TENANTS: with no LABOUR_HR rate there is nothing to take a percentage of, so a FIXED
 * FLOOR applies — any labour under £5/hr warns. A guard that only works on well-configured tenants
 * is one that fails exactly when it is most needed.
 */
export type PlausibleLine = { item_type: string; qty: number; unit_price: number; unit_cost: number | null };

export type LineFlag =
  | { rule: 'B'; fixQty: 1; fixUnitPrice: number } // fixUnitPrice = the value currently in the qty box
  | { rule: 'E' } // implausible quantity (> 20) — round money typed into qty, which A and B both miss
  | { rule: 'A' }
  | { rule: 'C'; cost: number; retail: number }
  // LABOUR (warn-only, never a fix): `rate` is the posted LABOUR_HR rate, or null when the tenant
  // has none and the fixed floor applied instead.
  | { rule: 'L1'; price: number; rate: number | null }
  | { rule: 'L2'; price: number; qty: number; rate: number };

const EPS = 0.005;
/** Fixed floor (£/hr) where no posted rate exists — the guard must not go silent on a new tenant. */
export const LABOUR_FLOOR_NO_RATE = 5;
export const LABOUR_L1_FRACTION = 0.05;
export const LABOUR_L2_FRACTION = 0.25;
export const LABOUR_L2_MIN_HOURS = 8;

export type PlausibleOpts = {
  /** The site's posted LABOUR_HR rate in POUNDS. null/undefined → the fixed floor is used. */
  postedLabourRate?: number | null;
};

export function lineFlags(l: PlausibleLine, opts?: PlausibleOpts): LineFlag[] {
  const out: LineFlag[] = [];
  if (l.item_type === 'labour') return labourFlags(l, opts);
  const qty = l.qty, up = l.unit_price, uc = l.unit_cost;
  if (!(qty > 0)) return out; // blank / zero quantity — nothing to judge yet
  // B / E / A are MUTUALLY EXCLUSIVE (one quantity-shaped suspicion per line, never two warnings):
  // B is precise + fixable; E catches a large round quantity (>20) that A's non-integer test misses;
  // A catches a fractional 10–20 quantity. C (margin) is independent and may co-fire.
  if (Math.abs(up - 1) < EPS && qty > 1) {
    out.push({ rule: 'B', fixQty: 1, fixUnitPrice: qty }); // £1.00 unit price + qty>1 = price-in-quantity
  } else if (qty > 20) {
    out.push({ rule: 'E' }); // quantity > 20 — implausible for a part (round money typed into qty)
  } else if (!Number.isInteger(qty) && qty > 10) {
    out.push({ rule: 'A' }); // fractional part-quantity above 10
  }
  if (uc != null && qty * uc > qty * up && qty * up > 0) {
    out.push({ rule: 'C', cost: qty * uc, retail: qty * up }); // negative-margin line (STRICT >, not ≥)
  }
  return out;
}

/**
 * LABOUR rules — price-shaped, never quantity-shaped (see the header). Warn-only, mutually
 * exclusive (L1 is the stronger signal), and silent on the two cases that are always legitimate:
 * a blank line, and a genuinely free £0 line (goodwill work — nine exist in the live tenant).
 */
function labourFlags(l: PlausibleLine, opts?: PlausibleOpts): LineFlag[] {
  const qty = l.qty, price = l.unit_price;
  if (!(qty > 0)) return [];      // nothing entered yet
  if (!(price > 0)) return [];     // £0 = goodwill/free, an explicit choice — never a typo
  const rate = opts?.postedLabourRate;
  if (rate == null || !(rate > 0)) {
    // No posted rate to take a percentage of → the fixed floor, so the check is never absent.
    return price < LABOUR_FLOOR_NO_RATE - EPS ? [{ rule: 'L1', price, rate: null }] : [];
  }
  if (price <= rate * LABOUR_L1_FRACTION + EPS) return [{ rule: 'L1', price, rate }];
  if (price <= rate * LABOUR_L2_FRACTION + EPS && qty >= LABOUR_L2_MIN_HOURS) return [{ rule: 'L2', price, qty, rate }];
  return [];
}

/**
 * Invoice-level parts profit (pre-issue only). Mirrors lib/quote-totals EXACTLY (the one margin model):
 * RETAIL sums every non-labour line — including negative discount lines and unknown-cost parts; COST
 * sums KNOWN costs only (a null cost is unknown, never counted as 0). That makes `profit` an OPTIMISTIC
 * upper bound (unknown costs treated as their cheapest, £0): if even this loses money the loss is
 * GUARANTEED real, so the check never cries a false loss. Excluding a null cost from the cost side only
 * OVERSTATES profit, so `nullCostLines` (positive parts with unknown cost) lets the caller flag the
 * figure as incomplete — the true loss can only be worse. A discount (negative retail, no COGS) is a
 * real revenue reduction and IS counted, so a discount that drags the whole invoice negative is caught
 * even when no single line looks wrong. `hasParts` is false only for an empty/labour-only set.
 */
export type PartsProfit = { retailPennies: number; costPennies: number; profitPennies: number; nullCostLines: number; hasParts: boolean };
export function partsProfit(lines: PlausibleLine[]): PartsProfit {
  let retail = 0, cost = 0, nullCostLines = 0, parts = 0;
  for (const l of lines) {
    if (l.item_type === 'labour') continue;
    parts++;
    retail += Math.round(l.qty * l.unit_price * 100); // ALL non-labour retail (incl discounts + unknown-cost parts)
    if (l.unit_cost == null) { if (l.unit_price > 0) nullCostLines++; continue; } // unknown cost → excluded from cost only
    cost += Math.round(l.qty * l.unit_cost * 100);
  }
  return { retailPennies: retail, costPennies: cost, profitPennies: retail - cost, nullCostLines, hasParts: parts > 0 };
}

export const hasLineFlags = (l: PlausibleLine): boolean => lineFlags(l).length > 0;

/** Parse an estimate line (string-typed form fields) into a PlausibleLine. Blank cost = null
 *  (unknown), never 0 — a typed 0 is a real "known free" and is preserved. */
export function toPlausible(l: { item_type: string; qty: string | number; unit_price: string | number; unit_cost: string | number | null }): PlausibleLine {
  const cost = l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost);
  return { item_type: l.item_type, qty: Number(l.qty || 0), unit_price: Number(l.unit_price || 0), unit_cost: cost };
}
