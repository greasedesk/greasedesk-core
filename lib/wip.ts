/**
 * File: lib/wip.ts
 * THE single definition of "work in progress, not invoiced" — accepted or in-progress job cards
 * with no invoice raised. ONE where clause + ONE per-card value formula, so the dashboard WIP tile
 * (lib/dashboard-tiles.ts) and the list it links to (pages/admin/jobcards?filter=wip) can NEVER
 * disagree: a tile that leads to a different total is worse than no link. (Same discipline as
 * lib/invoice-list-filters.ts::listWhere, which keeps the debtors tile and the invoices list aligned.)
 */
import type { Prisma } from '@prisma/client';
import { poundsToPennies } from '@/lib/quote-totals';

export const WIP_STATUSES = ['accepted', 'in_progress'] as const;
export const WIP_AGE_DAYS = 14; // a card open longer than this is the actual problem — surfaced, not hidden

/** The filter: accepted/in-progress cards with no invoice raised. The lifecycle already excludes
 *  drafts/quotes (pre-acceptance) and invoiced/paid/done (an invoice only exists from `invoiced` on);
 *  `invoice: { is: null }` is belt-and-braces (invoice is a to-one RELATION, not a scalar FK, so the
 *  filter is `{ is: null }`, never `invoice: null`). site_id ∈ siteIds already scopes to the tenant. */
export function wipCardsWhere(siteIds: string[]): Prisma.JobCardWhereInput {
  return { site_id: { in: siteIds }, status: { in: WIP_STATUSES as unknown as any[] }, invoice: { is: null } };
}

/** Ex-VAT value of a WIP card = its working-draft bill (labour + parts, in pounds), persisted straight
 *  from computeQuoteTotals on every save — so it IS the quote chokepoint's output, never recomputed.
 *  A COMEBACK bills at £0 (zero-revenue policy): it counts as open work but adds nothing. Pennies. */
export function wipCardValuePennies(card: { is_comeback: boolean; labour_bill_numeric: unknown; parts_bill_numeric: unknown }): number {
  if (card.is_comeback) return 0;
  return poundsToPennies(Number(card.labour_bill_numeric ?? 0)) + poundsToPennies(Number(card.parts_bill_numeric ?? 0));
}

/** Whole days a card has been open (created → now), floored at 0. */
export function daysOpen(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
}
