/**
 * File: lib/wip.ts
 * THE single definition of "work in progress, not invoiced" — accepted or in-progress job cards
 * with no invoice raised. ONE where clause + ONE per-card value formula, so the dashboard WIP tile
 * (lib/dashboard-tiles.ts) and the list it links to (pages/admin/jobcards?filter=wip) can NEVER
 * disagree: a tile that leads to a different total is worse than no link. (Same discipline as
 * lib/invoice-list-filters.ts::listWhere, which keeps the debtors tile and the invoices list aligned.)
 */
import type { Prisma } from '@prisma/client';

export const WIP_STATUSES = ['accepted', 'in_progress'] as const;
export const WIP_AGE_DAYS = 14; // a card open longer than this is the actual problem — surfaced, not hidden

/** The filter: accepted/in-progress cards with no invoice raised. The lifecycle already excludes
 *  drafts/quotes (pre-acceptance) and invoiced/paid/done (an invoice only exists from `invoiced` on);
 *  `invoice: { is: null }` is belt-and-braces (invoice is a to-one RELATION, not a scalar FK, so the
 *  filter is `{ is: null }`, never `invoice: null`). site_id ∈ siteIds already scopes to the tenant. */
export function wipCardsWhere(siteIds: string[]): Prisma.JobCardWhereInput {
  return { site_id: { in: siteIds }, status: { in: WIP_STATUSES as unknown as any[] }, invoice: { is: null } };
}

/**
 * THE LINE VALUES, DERIVED. One grouped query over JobCardItem for the given cards; pennies.
 *
 * ── WHY THIS DERIVES INSTEAD OF READING A CACHED FIGURE ─────────────────────────────────────────
 * It used to read JobCard.labour_bill_numeric + parts_bill_numeric, persisted by
 * pages/api/jobcard-quote on every save. That is a denormalisation with EXACTLY ONE WRITER, and a
 * denormalised figure diverges the moment anything creates the underlying rows by another route.
 * Fixtures are the most common other route, and it had already happened: four ZZ cards each
 * carrying a £980 line while their stored numerics read 0/0 — £3,920 of open work missing from the
 * tile. The same shape appeared four separate times in one day (Payment.site_id,
 * NotificationLog.group_id, the JobCard cost numerics, and this).
 *
 * IF YOU ARE HERE TO OPTIMISE A DASHBOARD QUERY: do not reintroduce the cache. It will agree with
 * the lines on the day you test it. That is the property that makes it dangerous, not safe. The
 * measurement that settled it: cache read 32ms, derived 93ms — and tiles run under Promise.all
 * beside P&L computes that take longer, so the second round trip is absorbed entirely.
 *
 * Rounded PER LINE and then summed, matching computeQuoteTotals' arithmetic rather than summing
 * pounds and rounding once — a figure that must agree with a quote must round the way the quote does.
 */
export async function wipLineValuesPennies(
  db: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<Array<{ job_card_id: string; pennies: bigint | number }>> },
  cardIds: string[],
): Promise<Map<string, number>> {
  if (!cardIds.length) return new Map();
  const rows = await db.$queryRawUnsafe(
    `SELECT job_card_id, COALESCE(SUM(ROUND(qty * unit_price * 100)), 0)::bigint AS pennies
       FROM "JobCardItem"
      WHERE job_card_id = ANY($1::text[])
      GROUP BY job_card_id`,
    cardIds,
  );
  return new Map(rows.map((r) => [r.job_card_id, Number(r.pennies)]));
}

/** Ex-VAT value of a WIP card, from its LINES (see wipLineValuesPennies for why not the cache).
 *  A COMEBACK bills at £0 (zero-revenue policy): it counts as open work but adds nothing. Pennies.
 *  A card absent from the map has no lines — genuinely £0, not unknown. */
export function wipCardValuePennies(card: { id: string; is_comeback: boolean }, lineValues: Map<string, number>): number {
  if (card.is_comeback) return 0;
  return lineValues.get(card.id) ?? 0;
}

/** Whole days a card has been open (created → now), floored at 0. */
export function daysOpen(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
}
