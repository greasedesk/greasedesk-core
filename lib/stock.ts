/**
 * File: lib/stock.ts
 * STOCK: what the garage owns, what it paid, what it got, and what HMRC is owed.
 * Pure, importing only the purchase model's margin arithmetic — no database, no browser.
 *
 * ── THE RECORD ASSERTS OWNERSHIP; THERE IS NO OWNERSHIP EDGE ────────────────────────────────────
 * A stock car has no VehicleOwnership row. The garage is NOT a Customer: a garage-as-customer row
 * would appear in marketing lists and MOT reminders and the garage would start texting itself, which
 * is the kind of thing discovered in production. The StockItem IS the assertion of ownership, and its
 * absence of a disposal is the assertion that it still holds.
 *
 * ── TWO DOCUMENTS OUT OF ONE RECORD, WITH DIFFERENT RULES ───────────────────────────────────────
 * THE STOCK BOOK is a compliance artefact. Its margin is sale − purchase and NOTHING else: under the
 * margin scheme, prep, parts and repairs may not be added to the purchase price (VAT Notice 718/1).
 * £800 of prep does not reduce the VAT by a penny.
 * THE PROFITABILITY VIEW is management information and costs are the whole point of it.
 * One record, two readings, and conflating them files a book that understates VAT — which is why
 * `bookRow` computes the margin from two figures and cannot see costs at all.
 */
import { VAT_FRACTION_DIVISOR } from '@/lib/stock-vat-fraction';

/**
 * HOW A CAR LEFT. Five ways, and only two of them are a sale — which is why `salePence` is nullable
 * on the disposal and why a book that assumed "left stock" meant "sold" would be wrong three times
 * out of five.
 */
export const DISPOSAL_KINDS = ['sold', 'traded_out', 'scrapped', 'returned', 'own_use'] as const;
export type DisposalKind = (typeof DISPOSAL_KINDS)[number];

export const DISPOSAL_LABELS: Record<DisposalKind, string> = {
  sold: 'Sold',
  traded_out: 'Traded out',
  scrapped: 'Scrapped',
  returned: 'Returned to seller',
  own_use: 'Taken into own use',
};

/**
 * WHAT THE VAT POSITION IS, BY HOW IT LEFT.
 *
 *   margin     a supply under the margin scheme. VAT on the margin, floored at zero per car.
 *   none       no supply, so no output tax. Scrapping is not a sale; a rescinded purchase is not one
 *              either — the car goes back and so does the money.
 *   unsettled  OWN USE. Taking a car into the courtesy fleet is a deemed supply and its treatment is
 *              the one thing here we cannot state, so nothing is computed. It is the priority item on
 *              the accountant list, and the book says so rather than printing a figure that would be
 *              believed. See [the courtesy-car taint] — the same question, arriving from the other side.
 */
export type VatPosition = 'margin' | 'none' | 'unsettled';

export function vatPositionFor(kind: DisposalKind): VatPosition {
  if (kind === 'sold' || kind === 'traded_out') return 'margin';
  if (kind === 'own_use') return 'unsettled';
  return 'none';
}

/** Does this way of leaving have a sale price at all? Three of the five do not. */
export function hasSalePrice(kind: DisposalKind): boolean {
  return kind === 'sold' || kind === 'traded_out';
}

export type BookRow = {
  /** THE REAL MARGIN, negative when the car lost money. Null while the car is still in stock. */
  marginPence: number | null;
  /**
   * WHAT IS OWED, floored at zero. A VAT RULE, NOT A REPORTING ONE: no VAT is due on a loss-making
   * car and losses cannot offset each other, which governs what you pay HMRC and not what the book
   * reports. A book showing zero where the margin was −£400 would hide the thing this feature exists
   * to surface, so `marginPence` above keeps the loss and only this figure is floored.
   *
   * NULL means no figure can honestly be given — own use, whose treatment is unsettled.
   */
  vatDuePence: number | null;
  vatPosition: VatPosition | null;
  /** Still held: the sale side of the book is empty, and that is an honest null rather than absence. */
  inStock: boolean;
};

/**
 * ONE ROW OF THE BOOK. It takes the purchase and the sale and CANNOT SEE COSTS — not as a discipline
 * but as a signature. A later reader wanting to "improve" the margin by netting prep off it would have
 * to change the arguments, which is a visible edit rather than an invisible one.
 */
export function bookRow(args: {
  purchasePence: number;
  disposal: { kind: DisposalKind; salePence: number | null } | null;
}): BookRow {
  if (!args.disposal) {
    return { marginPence: null, vatDuePence: null, vatPosition: null, inStock: true };
  }
  const position = vatPositionFor(args.disposal.kind);
  const sale = args.disposal.salePence;
  if (sale == null || !hasSalePrice(args.disposal.kind)) {
    // No consideration, so no margin to speak of. Scrapped and returned are not sales; own use is a
    // supply whose value we cannot state, and stating one would be worse than the gap.
    return { marginPence: null, vatDuePence: null, vatPosition: position, inStock: false };
  }
  const margin = sale - args.purchasePence;
  return {
    marginPence: margin,
    // FLOORED HERE AND NOWHERE ELSE.
    vatDuePence: position === 'margin' ? Math.round(Math.max(0, margin) / VAT_FRACTION_DIVISOR) : null,
    vatPosition: position,
    inStock: false,
  };
}

/**
 * WHICH SECTION OF A PERIOD'S BOOK A CAR FALLS IN — and it can be both, in different periods.
 *
 * A car acquired in January and sold in April appears in Q1 as IN STOCK with the sale side empty, and
 * in Q2 as a DISPOSAL. Same car, two periods, two sections, counted as a disposal exactly once.
 *
 * The book is a QUERY, not a filed artefact. What makes it reproducible is that the FIGURES are frozen
 * at disposal — so re-running Q1 next year gives what it gave then.
 */
export type BookSection = 'in_stock' | 'disposed' | 'not_yet' | 'gone_before';

export function sectionFor(args: {
  acquiredAt: Date; disposedAt: Date | null; periodStart: Date; periodEnd: Date;
}): BookSection {
  if (args.acquiredAt > args.periodEnd) return 'not_yet';
  if (args.disposedAt && args.disposedAt < args.periodStart) return 'gone_before';
  if (args.disposedAt && args.disposedAt <= args.periodEnd) return 'disposed';
  return 'in_stock';
}

/**
 * THE GAP, NAMED ON THE DOCUMENT RATHER THAN IN A COMMENT. Prep labour is costed at ZERO because no
 * standing-still rate exists — the wage bill excludes hourly staff and names them, so a rate derived
 * today would be understated by exactly the people who turn spanners. A typed rate would be a number
 * that looks measured. The book says this out loud; it is not a footnote in the source.
 */
/**
 * HOW LONG A CAR HAS BEEN HELD, in whole days. The single most useful number on a stock list, and the
 * one a garage counts on its fingers today.
 *
 * FLOORED AT ZERO, and counted from the acquisition DATE rather than a timestamp: a car bought this
 * morning is day 0, not "-1 days" because someone typed today's date and the clock had not caught up.
 * `asOf` is passed in rather than read from the clock so the figure is testable at a fixed instant —
 * a list that cannot be asserted is a list that drifts.
 */
export function daysInStock(acquiredAt: Date, asOf: Date): number {
  const day = 24 * 60 * 60 * 1000;
  const from = Date.UTC(acquiredAt.getUTCFullYear(), acquiredAt.getUTCMonth(), acquiredAt.getUTCDate());
  const to = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.max(0, Math.round((to - from) / day));
}

export const LABOUR_AT_ZERO_NOTE =
  'Prep labour is not costed. There is no measured workshop rate yet, and a typed one would look like a measurement.';

/** The one thing about own use we can state: that we cannot state it. */
export const OWN_USE_UNSETTLED_NOTE =
  'Taking a car into own use is a deemed supply and its VAT treatment is not settled here — ask your accountant before filing. No figure is shown because any figure would be believed.';
