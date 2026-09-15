/**
 * File: lib/stock-prep.ts
 *
 * PREPARING OUR OWN STOCK. A job card linked to a StockItem bills nobody: it is the garage working on
 * its own asset, and the money it consumes belongs to that car's reconditioning cost base.
 *
 * Pure. The predicate, the refusal wording and the costing rule live here so that the invoice paths,
 * the stock book and the page cannot each decide separately what "internal" means.
 */
import { LABOUR_AT_ZERO_NOTE } from '@/lib/stock';

/**
 * THE LINK IS THE FLAG. One column, one predicate, so no reader can disagree with another about
 * whether a card is internal — and no second boolean exists to fall out of step with it.
 */
export function isInternalStock(card: { stock_item_id?: string | null } | null | undefined): boolean {
  return !!card?.stock_item_id;
}

/**
 * Why an invoice cannot be raised. Says what to do instead, because a refusal that only says no
 * leaves someone converting the card back to a customer card to get past it — which would put a
 * debtor on the books for a car the garage owns.
 */
export const INTERNAL_STOCK_INVOICE_REFUSAL =
  'This card is preparing a car we own, so there is nobody to invoice. Its parts already count '
  + 'against that car in the stock book. If this work really is being billed to a customer, unlink '
  + 'it from the stock item first — that is a different job from raising the invoice.';

/**
 * WHAT A STOCK CARD SHOWS WHERE A CUSTOMER NAME WOULD GO.
 *
 * Not a dash. A dash reads as missing data — somebody forgot to fill it in — and invites the exact
 * repair that caused this: typing the owner's own name into the customer field, which is the
 * garage-as-Customer trap arriving from the other end. This says the absence is the answer.
 */
export const STOCK_NO_CUSTOMER = 'Stock — no customer';

export type PrepLine = {
  item_type: 'labour' | 'part' | 'misc' | 'fixed';
  qty: unknown;
  unit_cost: unknown;
};

export type PrepCost = {
  /** GROSS parts cost actually consumed, in pence. */
  partsPence: number;
  /** Lines whose trade cost is UNKNOWN — counted, never valued at zero. */
  unknownCostLines: number;
  /** Labour lines seen. Reported so the note beside them is not a claim about an empty set. */
  labourLines: number;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * WHAT A PREP CARD ACTUALLY COSTS THE GARAGE.
 *
 * PARTS AT COST, NOT AT RETAIL. The retail price of a part fitted to our own car is not money that
 * left the building; billing ourselves at retail would inflate the cost base and understate the
 * margin on every car we prep. `unit_cost` is the trade cost and is the only figure used.
 *
 * A NULL unit_cost IS UNKNOWN, NOT ZERO — the rule the margin readers already follow. An ad-hoc part
 * nobody has catalogued must be COUNTED and surfaced, because a cost base quietly missing a £400
 * turbo reads as a better margin than the car earned.
 *
 * LABOUR AT ZERO, and the note says so. There is no measured workshop rate, and a typed one would
 * look like a measurement — the same ruling the stock book already carries. Labour lines are counted
 * so the page can say "and 4 labour lines, not costed" rather than silently omitting them.
 *
 * `misc` and `fixed` are NOT counted. A fixed-price bundle is a SELLING price with optional cost, and
 * misc is a catch-all; valuing either as a cost would be inventing a number. They surface as unknown.
 */
export function prepCost(lines: PrepLine[]): PrepCost {
  let partsPence = 0;
  let unknownCostLines = 0;
  let labourLines = 0;

  for (const l of lines) {
    if (l.item_type === 'labour') { labourLines += 1; continue; }
    const cost = num(l.unit_cost);
    if (cost === null) { unknownCostLines += 1; continue; }
    if (l.item_type !== 'part') { unknownCostLines += 1; continue; }
    const qty = num(l.qty) ?? 1;
    partsPence += Math.round(cost * qty * 100);
  }
  return { partsPence, unknownCostLines, labourLines };
}

/** What the book says beside a prep card's figure. Reuses the book's own wording, never a second one. */
export const PREP_LABOUR_NOTE = LABOUR_AT_ZERO_NOTE;

/** Said only when there ARE unknowns — a warning shown always is furniture and stops being read. */
export function unknownCostNote(c: PrepCost): string | null {
  if (!c.unknownCostLines) return null;
  return `${c.unknownCostLines} line${c.unknownCostLines === 1 ? '' : 's'} on this car have no trade cost recorded, `
    + 'so they are not in the figure. A cost base missing a part reads as a better margin than the car earned.';
}
