/**
 * File: lib/stock-sold.ts
 *
 * WHAT THE CARS THAT LEFT ACTUALLY DID — revenue, profit, how long they sat, over a chosen period.
 *
 * Pure. The period comes in as a range and the rows come in already read; this module does the
 * arithmetic and nothing else, so every rule here is testable without a database.
 *
 * ── WHY THIS IS REPRODUCIBLE ────────────────────────────────────────────────────────────────────
 *
 * The figures froze at disposal — prep parts snapshotted per card, non-parts costs snapshotted net of
 * credits — and the period keys on `disposed_at`, which never changes. So re-running last quarter next
 * year gives what it gave then, which is the whole reason the freeze exists.
 *
 * ONE EXCEPTION, AND IT IS NAMED: average days in stock is computed from DATES, not from a frozen
 * number. It reads the arrival date, so it is only as stable as that date. Fixed while it is free —
 * five stock rows existed when arrived_at landed and all of them fall back to the purchase date, so
 * no historic average moves. Recording it here because the next person to add a backfill needs to
 * know they would be moving a reported figure.
 */

/** SALES ONLY. Scrapped, returned and own-use are not sales and must not dilute a sales average. */
export const SALE_KINDS = ['sold', 'traded_out'] as const;
export const isSaleKind = (k: unknown): boolean => (SALE_KINDS as readonly string[]).includes(String(k));

export type SoldRow = {
  stockItemId: string;
  registration: string;
  disposedAt: Date;
  kind: string;
  salePence: number | null;
  purchasePence: number;
  /** Frozen at disposal: prep parts at trade cost plus non-parts costs, net of credits. */
  costsPence: number;
  /** Days on the forecourt, arrival to disposal. NULL if the car never recorded an arrival. */
  daysInStock: number | null;
};

export type SoldSummary = {
  /** Cars that LEFT in the period, however they left. The denominator for nothing. */
  disposals: number;
  /** Cars SOLD in the period. The denominator for every average below, and it is stated on the tile. */
  sold: number;
  revenuePence: number;
  /** Sale minus purchase minus frozen costs. Gross, before fixed monthly costs and tax. */
  profitPence: number;
  /** profit ÷ cars SOLD. NULL when nothing sold — never 0, which would read as "we made nothing". */
  avgProfitPence: number | null;
  /** Mean days on the forecourt for sold cars that HAVE an arrival date. NULL when none do. */
  avgDaysInStock: number | null;
  /** Sold cars with no arrival recorded, so the average above does not cover them. Named, not hidden. */
  daysUnknown: number;
  /** Left the period NOT as a sale — scrapped, returned, own use. Counted, never averaged. */
  nonSales: number;
};

/**
 * THE DENOMINATOR IS CARS SOLD, NOT CARS DISPOSED.
 *
 * A scrapped car leaving in the period is not a bad sale, and dividing profit by every disposal would
 * drag the average down as though it were one. So sales and non-sales are counted separately and only
 * sales reach the averages — and `nonSales` is published so the two numbers can be reconciled by a
 * reader rather than silently differing.
 */
export function summariseSold(rows: SoldRow[]): SoldSummary {
  const sales = rows.filter((r) => isSaleKind(r.kind));
  let revenue = 0, profit = 0, days = 0, withDays = 0;
  for (const r of sales) {
    const sale = r.salePence ?? 0;
    revenue += sale;
    profit += sale - r.purchasePence - r.costsPence;
    if (r.daysInStock !== null) { days += r.daysInStock; withDays += 1; }
  }
  return {
    disposals: rows.length,
    sold: sales.length,
    revenuePence: revenue,
    profitPence: profit,
    // NULL, not 0: "no cars sold" and "cars sold at no profit" are different statements.
    avgProfitPence: sales.length ? Math.round(profit / sales.length) : null,
    avgDaysInStock: withDays ? Math.round(days / withDays) : null,
    daysUnknown: sales.length - withDays,
    nonSales: rows.length - sales.length,
  };
}

/**
 * WHAT THE PERIOD PICKER OFFERS. The dashboard's own presets, plus ALL TIME.
 *
 * `all_time` is not in lib/dashboard-periods because nothing there needed it: every preset assumes
 * enough history for a month to mean something. A dealer with five cars sold wants the lifetime
 * figure, and on a young yard every other preset reads zero.
 */
export const SOLD_EXTRA_PRESET = 'all_time' as const;
export const ALL_TIME_FROM = new Date('2000-01-01T00:00:00.000Z');

/** The sentence under the averages. Says the denominator ON THE FACE OF IT, not in a tooltip. */
export function denominatorNote(s: SoldSummary): string {
  if (!s.sold) return 'Nothing sold in this period.';
  const base = `Averages are over the ${s.sold} ${s.sold === 1 ? 'car' : 'cars'} SOLD in this period`;
  const nonSale = s.nonSales
    ? `; ${s.nonSales} other ${s.nonSales === 1 ? 'car' : 'cars'} left without being sold and ${s.nonSales === 1 ? 'is' : 'are'} not in them`
    : '';
  const unknown = s.daysUnknown
    ? `. ${s.daysUnknown} of them recorded no arrival date, so the days figure does not cover ${s.daysUnknown === 1 ? 'it' : 'them'}`
    : '';
  return `${base}${nonSale}${unknown}.`;
}
