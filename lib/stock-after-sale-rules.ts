/**
 * File: lib/stock-after-sale-rules.ts
 *
 * AFTER THE SALE — comeback and warranty work done on a car we had already sold.
 *
 * Pure and client-safe. The reader that fetches the cards is lib/stock-after-sale; the car page and the
 * sold dashboard both render from what this decides.
 *
 * ── BESIDE THE SALE PROFIT, NEVER INSIDE IT ─────────────────────────────────────────────────────
 * A sold car's figures FROZE at disposal, so re-running a past quarter gives what it gave then. Work
 * done on the car afterwards is real money spent back, and it is SHOWN — but as its own figure, labelled
 * "after the sale", so the frozen profit never moves and the reader can still see what the car really
 * cost. NU14KUF: a margin at sale, and then a comeback on 18 August.
 *
 * It is NOT frozen, and says so: it grows as work is done, so a closed period's "after the sale" can
 * change next month. That is the point of it.
 *
 * ── COSTED EXACTLY AS PREP IS ───────────────────────────────────────────────────────────────────
 * Parts at trade cost through lib/stock-prep::prepCost — the SAME function, not a second copy — so a
 * part without a trade cost is COUNTED as unknown, never valued at zero, and a fixed-price line is a
 * selling price with no cost figure. LABOUR IS NOT COSTED: its hours are shown and the note says why,
 * in the same words and for the same reason as prep labour. When a measured rate exists, both get it.
 */
import { prepCost, type PrepCost } from '@/lib/stock-prep';
import { LABOUR_AT_ZERO_NOTE } from '@/lib/stock';

export const AFTER_SALE_TITLE = 'After the sale';

export const AFTER_SALE_NOTE =
  'Comeback and warranty work on this car since it was sold. Shown beside the sale profit, never in it: '
  + 'that figure froze when the car sold, so a past period re-runs the same. This one grows as work is done.';

/** Prep's sentence, with prep's subject swapped — the reason is the one ruling, not a second wording of it. */
export const AFTER_SALE_LABOUR_NOTE = LABOUR_AT_ZERO_NOTE.replace(/^Prep labour/, 'Labour after the sale');

export type AfterSaleLine = { item_type: string; qty: unknown; unit_cost: unknown; labour_hours?: unknown };
export type AfterSaleCardInput = {
  cardId: string; createdAt: Date; isComeback: boolean;
  /** The invoice number when the card has been invoiced — then `lines` are the FROZEN invoice lines. */
  invoiceNumber: string | null;
  lines: AfterSaleLine[];
};
export type AfterSaleCard = AfterSaleCardInput & { cost: PrepCost; hours: number; invoiced: boolean };
export type AfterSaleFigures = {
  cards: AfterSaleCard[];
  partsPence: number; unknownCostLines: number; hours: number; labourLines: number;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
};

/**
 * HOURS ON A LINE. A labour line carries its hours in qty; a fixed line carries its labour content in
 * labour_hours, per unit. Anything else carries none. Hours are REPORTED — never multiplied by a rate.
 */
export function lineHours(l: AfterSaleLine): number {
  if (l.item_type === 'labour') return num(l.qty) ?? 0;
  const h = num(l.labour_hours);
  return h === null ? 0 : h * (num(l.qty) ?? 1);
}

export function afterSaleFigures(cards: AfterSaleCardInput[]): AfterSaleFigures {
  const out: AfterSaleCard[] = cards
    .map((c) => ({
      ...c,
      cost: prepCost(c.lines as never),
      hours: Math.round(c.lines.reduce((t, l) => t + lineHours(l), 0) * 100) / 100,
      invoiced: c.invoiceNumber !== null,
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    cards: out,
    partsPence: out.reduce((t, c) => t + c.cost.partsPence, 0),
    unknownCostLines: out.reduce((t, c) => t + c.cost.unknownCostLines, 0),
    hours: Math.round(out.reduce((t, c) => t + c.hours, 0) * 100) / 100,
    labourLines: out.reduce((t, c) => t + c.cost.labourLines, 0),
  };
}

/**
 * THE WINDOW A CARD MUST FALL IN to count against a sale: on or after the sale day, and before the same
 * car next came back into stock (a buyback or a return starts a new stock record, whose work is its own).
 */
export function inAfterSaleWindow(createdAt: Date, soldAt: Date, nextAcquiredAt: Date | null): boolean {
  const saleDay = Date.UTC(soldAt.getUTCFullYear(), soldAt.getUTCMonth(), soldAt.getUTCDate());
  if (createdAt.getTime() < saleDay) return false;
  return nextAcquiredAt === null || createdAt.getTime() < nextAcquiredAt.getTime();
}

/** The one-line summary: parts, the unknowns named, and the hours with the plain statement that they are not costed. */
export function afterSaleSummary(f: Pick<AfterSaleFigures, 'partsPence' | 'unknownCostLines' | 'hours'>, cardCount: number): string {
  const pounds = `£${(f.partsPence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const unknown = f.unknownCostLines
    ? `, and ${f.unknownCostLines} line${f.unknownCostLines === 1 ? '' : 's'} with no trade cost recorded`
    : '';
  const hours = f.hours ? `; ${f.hours.toLocaleString('en-GB', { maximumFractionDigits: 2 })} h of labour, not costed` : '';
  return `${cardCount} card${cardCount === 1 ? '' : 's'}: ${pounds} of parts${unknown}${hours}.`;
}
