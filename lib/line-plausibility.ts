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
 * Labour is excluded from every rule: fractional hours (0.5, 2.5, 5.45) are legitimate and the qty→1
 * fix is meaningless for time. On one line, B takes precedence over A (B is precise + fixable); C is
 * independent and may co-fire with either.
 */
export type PlausibleLine = { item_type: string; qty: number; unit_price: number; unit_cost: number | null };

export type LineFlag =
  | { rule: 'B'; fixQty: 1; fixUnitPrice: number } // fixUnitPrice = the value currently in the qty box
  | { rule: 'A' }
  | { rule: 'C'; cost: number; retail: number };

const EPS = 0.005;

export function lineFlags(l: PlausibleLine): LineFlag[] {
  const out: LineFlag[] = [];
  if (l.item_type === 'labour') return out; // fractional hours are legitimate; qty→1 is meaningless
  const qty = l.qty, up = l.unit_price, uc = l.unit_cost;
  if (!(qty > 0)) return out; // blank / zero quantity — nothing to judge yet
  if (Math.abs(up - 1) < EPS && qty > 1) {
    out.push({ rule: 'B', fixQty: 1, fixUnitPrice: qty }); // £1.00 unit price + qty>1 = price-in-quantity
  } else if (!Number.isInteger(qty) && qty > 10) {
    out.push({ rule: 'A' }); // fractional part-quantity above 10
  }
  if (uc != null && qty * uc > qty * up && qty * up > 0) {
    out.push({ rule: 'C', cost: qty * uc, retail: qty * up }); // negative-margin line (STRICT >, not ≥)
  }
  return out;
}

export const hasLineFlags = (l: PlausibleLine): boolean => lineFlags(l).length > 0;

/** Parse an estimate line (string-typed form fields) into a PlausibleLine. Blank cost = null
 *  (unknown), never 0 — a typed 0 is a real "known free" and is preserved. */
export function toPlausible(l: { item_type: string; qty: string | number; unit_price: string | number; unit_cost: string | number | null }): PlausibleLine {
  const cost = l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost);
  return { item_type: l.item_type, qty: Number(l.qty || 0), unit_price: Number(l.unit_price || 0), unit_cost: cost };
}
