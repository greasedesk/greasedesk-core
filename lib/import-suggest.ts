/**
 * File: lib/import-suggest.ts
 * Catalogue SUGGESTIONS for an imported line. Suggest and rank — NEVER auto-accept.
 *
 * Two independent signals, because each alone produces false friends on this very data:
 *   PRICE  — the catalogue is priced on the same figures as the invoices, so an equal price is a
 *            strong hint. But £83.33 matches BOTH "Brake Fluid Flush" and "Software Update to DME",
 *            and £20.83 matches both "Collection and Delivery" and "Supply and fit no.4 Coil Pack".
 *   WORDS  — shared significant words. Alone this fuzzed "Replace FRONT Brake Discs…" onto the REAR
 *            pads item, because the strings are 80%+ similar and differ on the one word that matters.
 *
 * Ranking is price-match AND word-overlap; a price match with ZERO shared words is surfaced but
 * explicitly marked `weak`, because on the May set every such pair was wrong.
 */
import type { ItemType } from '@prisma/client';

export type CatalogueLite = {
  id: string; code: string; title: string | null; name: string;
  item_type: ItemType; unit_price: any; unit_cost: any; labour_hours: any; active: boolean;
};

export type Suggestion = {
  itemId: string; label: string; unitPricePennies: number;
  unitCostPennies: number | null; labourHours: number | null;
  priceMatch: boolean; sharedWords: number; weak: boolean; score: number;
};

// Words that carry no discriminating power in this domain — dropping them stops "service" alone
// scoring a match between an oil service and a transmission service.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'using', 'only', 'new', 'service', 'genuine', 'quality',
  'through', 'cars', 'grade', 'from', 'per', 'each', 'inc', 'exc',
]);

const tokens = (s: string): Set<string> =>
  new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );

const overlap = (a: string, b: string): number => {
  const A = tokens(a), B = tokens(b);
  let n = 0;
  A.forEach((w) => { if (B.has(w)) n++; });
  return n;
};

const p2 = (v: any) => Math.round(Number(v) * 100);

/**
 * Rank catalogue items for one invoice line. Returns at most `limit`, best first.
 * A tolerance of 1p absorbs Xero's 4dp thirds (66.6667) against a 2dp catalogue price (66.67).
 */
export function suggestForLine(
  description: string,
  unitPrice: number,
  catalogue: CatalogueLite[],
  limit = 5,
): Suggestion[] {
  const linePennies = Math.round(unitPrice * 100);

  const scored = catalogue.map((c) => {
    const priceMatch = Math.abs(p2(c.unit_price) - linePennies) <= 1;
    const label = c.title || c.name || c.code;
    const sharedWords = overlap(description, label);
    // Price is worth more than any single word, but words break price ties and demote coincidences.
    const score = (priceMatch ? 100 : 0) + sharedWords * 10 + (c.active ? 1 : 0);
    return {
      itemId: c.id,
      label,
      unitPricePennies: p2(c.unit_price),
      unitCostPennies: c.unit_cost == null ? null : p2(c.unit_cost),
      labourHours: c.labour_hours == null ? null : Number(c.labour_hours),
      priceMatch,
      sharedWords,
      weak: priceMatch && sharedWords === 0, // price coincidence — on the May set, always wrong
      score,
    };
  });

  return scored
    .filter((s) => s.priceMatch || s.sharedWords > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
