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
/**
 * ── THE OTHER KIND OF STOCK CARD, AND WHY IT IS A DIFFERENT COLUMN ──────────────────────────────
 *
 * A SALE card sells a car out of stock. It reads `sale_of_stock_item_id`, never `stock_item_id`.
 *
 * isInternalStock above is what lib/invoice-issue::refuseIfInternalStock asks before minting, and a
 * prep card is refused because there is nobody to bill. A sale card must MINT — and the temptation
 * is to put the sale case inside that refusal as an exception. Do not. A refusal with an exception
 * in it is one exception away from not being a refusal, and the exception would be sitting in the
 * one function standing between a garage and a debtor invented for a car it owns.
 *
 * Two columns, two predicates, and refuseIfInternalStock stays exactly as written: it never hears
 * about sale cards at all, so it cannot be weakened by someone reasoning about them.
 */
export function isSaleCard(card: { sale_of_stock_item_id?: string | null } | null | undefined): boolean {
  return !!card?.sale_of_stock_item_id;
}

/** A card is one or the other. Both set is a contradiction, not a richer card. */
export function isPrepAndSale(card: { stock_item_id?: string | null; sale_of_stock_item_id?: string | null } | null | undefined): boolean {
  return isInternalStock(card) && isSaleCard(card);
}

export const SALE_AND_PREP_REFUSAL =
  'This card is marked both as preparing a car and as selling one. Those are different jobs with '
  + 'different money: prep costs count against the car, a sale bills a customer for it. Unlink '
  + 'whichever is wrong before going on.';

/**
 * A SALE CARD IS NOT WORK. It bills a car, not hours, so it is not open work waiting to be done and
 * must never be counted as such — see lib/wip, where the exclusion lives.
 */
export const SALE_CARD_NOT_WORK_NOTE =
  'Selling a car, not a job — no workshop time is expected against this card.';

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


/**
 * ── THE LINES, GROUPED BY CARD ──────────────────────────────────────────────────────────────────
 *
 * "£657.13 of parts across 1 card" tells a person nothing. What they want is the turbo and the DPF,
 * each at its trade cost, with the card it came from — and they want that to stay readable when the
 * car has accumulated thirty lines over six months.
 *
 * GROUPED BY CARD, NOT BY DATE. A card is the unit of work — "the turbo job", "the MOT prep" — and it
 * already carries a date and an identity. Thirty lines across five cards read as five things; thirty
 * lines in date order read as thirty.
 *
 * LABOUR IS LISTED AND VALUED AT NOTHING. Omitting it would make a card's subtotal look like the whole
 * job; showing it at a rate would be the invented number the book refuses. So it appears in place,
 * priced at nothing, and the card says so.
 *
 * AN UNKNOWN TRADE COST IS LISTED IN PLACE, with its reason. Counting it in an aggregate elsewhere
 * tells you a figure is a floor; showing the line tells you WHICH line is holding it down.
 */
export type PrepLineDetail = {
  description: string;
  itemType: string;
  qty: number;
  /** NULL = no trade cost recorded. Never 0 — 0 means genuinely free. */
  unitCostPence: number | null;
  /** qty × unit cost, in pence. NULL when the cost is unknown, and 0 for labour by rule. */
  linePence: number | null;
  /** Why this line contributes nothing, when it does not. Null on an ordinary costed part. */
  excludedBecause: string | null;
};

export type PrepCardGroup = {
  cardId: string;
  createdAt: Date;
  /** What this card put into the car — parts at trade cost only. */
  subtotalPence: number;
  labourLines: number;
  unknownCostLines: number;
  lines: PrepLineDetail[];
};

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

export function groupPrepLines(
  cards: Array<{ id: string; created_at: Date; items: PrepLine[] & Array<{ description?: unknown }> }>,
): PrepCardGroup[] {
  return cards.map((c) => {
    const lines: PrepLineDetail[] = (c.items ?? []).map((l) => {
      const qty = numOrNull((l as { qty: unknown }).qty) ?? 1;
      const cost = numOrNull((l as { unit_cost: unknown }).unit_cost);
      const description = String((l as { description?: unknown }).description ?? '').slice(0, 120);
      if (l.item_type === 'labour') {
        return {
          description, itemType: 'labour', qty, unitCostPence: null, linePence: 0,
          excludedBecause: LABOUR_AT_ZERO_NOTE,
        };
      }
      if (cost === null) {
        return {
          description, itemType: l.item_type, qty, unitCostPence: null, linePence: null,
          excludedBecause: 'No trade cost recorded, so this line is not in the figure.',
        };
      }
      if (l.item_type !== 'part') {
        return {
          description, itemType: l.item_type, qty, unitCostPence: Math.round(cost * 100), linePence: null,
          excludedBecause: l.item_type === 'fixed'
            ? 'A fixed-price service is a SELLING price with optional cost — valuing it as a cost would invent a number.'
            : 'Miscellaneous lines carry no trade cost we can rely on.',
        };
      }
      return {
        description, itemType: 'part', qty, unitCostPence: Math.round(cost * 100),
        linePence: Math.round(cost * qty * 100), excludedBecause: null,
      };
    });
    const totals = prepCost(c.items ?? []);
    return {
      cardId: c.id, createdAt: c.created_at, subtotalPence: totals.partsPence,
      labourLines: totals.labourLines, unknownCostLines: totals.unknownCostLines, lines,
    };
  }).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * HOW MANY CARDS BEFORE THE LIST COLLAPSES. Below this every card is open, because collapsing two
 * cards is chrome for no gain; at or above it they arrive summarised and the reader opens what they
 * want. Four is the point at which the page stops fitting a screen at typical card sizes.
 */
export const PREP_EXPAND_THRESHOLD = 4;

/**
 * A SOLD CAR SHOWS CARD-LEVEL TOTALS ONLY, and the page says why.
 *
 * The snapshot froze one row per card, not the lines — so the lines still exist on the card, but the
 * FROZEN RECORD does not reference them. Reading the live lines back against a frozen total is exactly
 * the drift the freeze exists to prevent: a card edited next March would change what last year’s
 * quarter appears to have cost. The detail is richer in stock than after sale, and that is honest —
 * it reflects what was actually frozen.
 */
export const FROZEN_DETAIL_NOTE =
  'This car has gone, so these are the figures frozen at disposal — one row per card, not the '
  + 'individual lines. The lines still exist on the cards, but the frozen record does not reference '
  + 'them, and reading them back now could disagree with what this car was reported to have cost.';
