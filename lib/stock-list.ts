/**
 * File: lib/stock-list.ts
 *
 * THE YARD, AS A LIST: its headline totals, its sort, and its search. Pure, and a leaf — no database,
 * no Prisma — so the page can import it and every rule here is testable without a browser.
 *
 * ── HONEST NULL, ALL THE WAY THROUGH ────────────────────────────────────────────────────────────
 *
 * A car with no stated sale price has NO projection. That absence is carried, never converted:
 *
 *   in a TOTAL   it contributes nothing, and the count of such cars is published beside the total.
 *                A figure resting on estimates that does not say how many cars have none is a figure
 *                the reader will take as covering the whole yard.
 *   in a SORT    it goes LAST, in both directions. Treating it as £0 would file a car nobody has
 *                priced among the worst cars in the yard, which is a claim about it.
 *   on a ROW     it reads blank. £0 would say "this car makes nothing".
 */
import { normalizeReg } from '@/lib/vehicle-identity';
import { STOCK_TABS, type StockTab } from '@/lib/stock';

/** Only what the list needs. Structural, so the page's row type and the store's both satisfy it. */
export type StockRowLike = {
  registration: string;
  description: string | null;
  acquiredAt: string;
  status: string;
  /** NULL when the car has not arrived — never 0. */
  daysInStock: number | null;
  /** Set once the car has gone. Its kind is shown on the row; see the Gone tab. */
  disposalKind?: string | null;
  purchasePence: number;
  prepPence: number;
  vatStatus: string;
  projectedSalePence: number | null;
  projectedProfitPence: number | null;
};

export type StockTotals = {
  /** Paid for the cars plus what has gone into them. A FACT — every car has one. */
  capitalPence: number;
  /** What the priced cars are expected to fetch. Covers `projected` cars only. */
  expectedRevenuePence: number;
  /** What those same cars are expected to make. */
  expectedProfitPence: number;
  cars: number;
  /** How many cars the two expectation figures are based on… */
  projected: number;
  /** …and how many they say nothing about. The reason the tiles are trustworthy. */
  unprojected: number;
};

/**
 * CAPITAL IS COUNTED FOR EVERY CAR; EXPECTATION ONLY FOR PRICED ONES.
 *
 * The split matters. Capital invested is money that has actually gone out and is known for all of
 * them, so a missing estimate must not reduce it. Expected revenue and profit are known only where
 * somebody has said what the car should fetch, so they cover a SUBSET — and `unprojected` is what
 * makes that subset legible rather than a quiet understatement.
 */
export function stockTotals(rows: StockRowLike[]): StockTotals {
  let capital = 0, revenue = 0, profit = 0, projected = 0, unprojected = 0;
  for (const r of rows) {
    capital += r.purchasePence + r.prepPence;
    if (r.projectedSalePence === null || r.projectedProfitPence === null) { unprojected += 1; continue; }
    revenue += r.projectedSalePence;
    profit += r.projectedProfitPence;
    projected += 1;
  }
  return {
    capitalPence: capital, expectedRevenuePence: revenue, expectedProfitPence: profit,
    cars: rows.length, projected, unprojected,
  };
}

export const SORT_KEYS = [
  'registration', 'acquiredAt', 'daysInStock', 'purchasePence', 'prepPence', 'investedPence',
  'projectedSalePence', 'projectedProfitPence', 'vatStatus',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

/** The one a yard is read by: the car that has been sitting longest, at the top. */
export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: 'daysInStock', dir: 'desc' };

const valueOf = (r: StockRowLike, k: SortKey): string | number | null => {
  switch (k) {
    case 'registration': return r.registration;
    case 'acquiredAt': return r.acquiredAt;
    case 'daysInStock': return r.daysInStock;   // null sorts LAST — a car not yet here has no answer
    case 'purchasePence': return r.purchasePence;
    case 'prepPence': return r.prepPence;
    case 'investedPence': return r.purchasePence + r.prepPence;
    case 'projectedSalePence': return r.projectedSalePence;
    case 'projectedProfitPence': return r.projectedProfitPence;
    case 'vatStatus': return r.vatStatus;
  }
};

/**
 * SORTED, WITH NULLS LAST IN BOTH DIRECTIONS.
 *
 * Not "nulls are zero" and not "nulls flip with the direction". A car nobody has priced is not the
 * least profitable car in the yard, and it is not the most profitable one either — it is a car with
 * no answer, and it belongs after every car that has one whichever way the column is pointing.
 *
 * Ties break on REGISTRATION so the list never jitters between two equal rows: a table that reorders
 * itself on refresh teaches a person not to trust its order at all.
 */
export function sortStock<T extends StockRowLike>(rows: T[], key: SortKey, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = valueOf(a, key), vb = valueOf(b, key);
    if (va === null && vb === null) return a.registration.localeCompare(b.registration);
    if (va === null) return 1;          // last, whichever way the column points
    if (vb === null) return -1;
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb));
    return cmp !== 0 ? cmp * sign : a.registration.localeCompare(b.registration);
  });
}

/**
 * SEARCH ON WHAT IS ON THE SCREEN: the registration and the make/model.
 *
 * The plate is matched through `normalizeReg`, the SAME canonical form find-or-create uses, so
 * "wt16 gmv" finds WT16GMV. Typing a plate with the space in it is the normal way to type a plate,
 * and a search that fails on it reads as "we do not have that car".
 */
export function matchStock(r: StockRowLike, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const plate = normalizeReg(q);
  if (plate && normalizeReg(r.registration)?.includes(plate)) return true;
  return (r.description ?? '').toLowerCase().includes(q.toLowerCase());
}


/**
 * ── WHICH TAB A CAR IS IN ───────────────────────────────────────────────────────────────────────
 *
 * GONE WINS over status. A disposed car keeps whatever status it last had — nothing rewrites it, and
 * rewriting it would destroy the record of what it was doing when it left — so "has it gone" is asked
 * first. Otherwise a car sold off the Advertised tab would go on being counted as advertised.
 */
export function tabFor(r: StockRowLike): StockTab {
  if (r.disposalKind) return 'gone';
  return (STOCK_TABS as readonly string[]).includes(r.status) && r.status !== 'gone'
    ? (r.status as StockTab)
    : 'in_prep';   // an unrecognised status shows SOMEWHERE rather than vanishing from every tab
}

/**
 * ── THE BUBBLE COUNTS THE WHOLE YARD, ALWAYS ────────────────────────────────────────────────────
 *
 * Deliberately computed from the UNFILTERED rows. A tab count that changes when you search is
 * answering a different question from the one you asked it: the bubble says how many cars are in a
 * state, and the list says which of those match what you typed. The list header reports "N of M" so
 * the two numbers are visibly different rather than silently disagreeing.
 *
 * EVERY CAR COUNTS, including one with no projection. A bubble counts cars in a state, which every
 * car has; a projection is a separate optional fact, and the tiles already name that gap separately.
 */
export function tabCounts(allRows: StockRowLike[]): Record<StockTab, number> {
  const out = Object.fromEntries(STOCK_TABS.map((t) => [t, 0])) as Record<StockTab, number>;
  for (const r of allRows) out[tabFor(r)] += 1;
  return out;
}
