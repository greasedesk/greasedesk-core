/**
 * File: lib/no-show.ts
 * A CUSTOMER'S NO-SHOW HISTORY — derived from their cards, never a stored counter.
 *
 * ── WHY DERIVED ─────────────────────────────────────────────────────────────────────────────────
 * The count exists so that whoever takes the NEXT booking sees "2 no-shows" before agreeing a slot
 * — someone with form gets asked for a deposit, or gets the slot nobody else wanted. A stored
 * counter would need a writer on every transition INCLUDING the reopen (no_show → draft, the
 * customer who turns up an hour late), and the reopen is exactly where a counter drifts. Derived,
 * a reopened card corrects the count by construction.
 *
 * The dates come from `start_at` — the slot they actually missed, which the off-diary rule
 * deliberately preserves on the card (the booking record survives; only the occupancy is freed).
 */
import type { Prisma } from '@prisma/client';

type Db = { jobCard: { findMany: (args: unknown) => Promise<unknown> } };

export type NoShowHistory = {
  count: number;
  /** Missed slots, most recent first. ISO dates, ready for the client. */
  dates: string[];
};

export async function noShowHistory(db: Prisma.TransactionClient | Db, customerId: string | null | undefined): Promise<NoShowHistory> {
  if (!customerId) return { count: 0, dates: [] };
  const rows = (await (db as Db).jobCard.findMany({
    where: { customer_id: customerId, status: 'no_show' },
    select: { start_at: true, created_at: true },
    orderBy: { start_at: 'desc' },
  })) as Array<{ start_at: Date | null; created_at: Date }>;
  return {
    count: rows.length,
    // start_at is guaranteed by the booking_exists gate for anything marked through the API; the
    // created_at fallback keeps a row honest if one ever arrives by another route.
    dates: rows.map((r) => (r.start_at ?? r.created_at).toISOString().slice(0, 10)),
  };
}

/**
 * BOOKED TIME LOST TO NO-SHOWS IN A PERIOD — the named slice of the capacity gap.
 *
 * ── ATTRIBUTION IS THE SLOT'S MONTH, DELIBERATELY ──────────────────────────────────────────────
 * The query keys on `start_at` — when the slot WAS — so a no-show marked on the 3rd against a slot
 * on the 28th of last month lands in LAST month, and a closed month's figure moves. That is
 * correct, not drift: the fact belongs to the month the time was lost and was merely learned late
 * — the same rule as a refund landing in the month the money left (owner's ruling 2026-08-19).
 * DO NOT "fix" this into the marking date; today's date never enters the query on purpose.
 * A reopen un-moves it in whatever month the slot sat — the derived-count argument again.
 *
 * ── BOOKED TIME, NOT SELLABLE LABOUR ────────────────────────────────────────────────────────────
 * The minutes are the diary FOOTPRINT (booking_duration_minutes; road test, parts wait included),
 * the same figure the forward-booked-hours read uses. Footprint runs longer than sellable labour,
 * so valuing it at the labour rate overstates the labour lost — the wording must say "booked
 * time", and any deflation factor would be an invented constant. The HOURS are a record (frozen
 * booking facts the off-diary rule preserves); the £ the caller puts on them is a valuation at
 * today's rate — the third such tile, see the history-or-model item.
 */
export async function noShowLostInPeriod(
  db: Prisma.TransactionClient | { jobCard: { findMany: (args: unknown) => Promise<unknown> } },
  args: { groupId: string; siteIds: string[]; from: Date; to: Date },
): Promise<{ count: number; minutes: number; perSite: Array<{ siteId: string; minutes: number }> }> {
  const rows = (await (db as { jobCard: { findMany: (a: unknown) => Promise<unknown> } }).jobCard.findMany({
    where: {
      group_id: args.groupId, site_id: { in: args.siteIds }, status: 'no_show',
      start_at: { gte: args.from, lt: args.to },
    },
    select: { site_id: true, booking_duration_minutes: true, start_at: true, end_at: true },
  })) as Array<{ site_id: string; booking_duration_minutes: number | null; start_at: Date | null; end_at: Date | null }>;
  const perSite = new Map<string, number>();
  let minutes = 0;
  for (const r of rows) {
    // Duration is the source of truth; start/end the derived fallback (lib/occupancy's rule).
    const m = r.booking_duration_minutes
      ?? (r.start_at && r.end_at ? Math.max(0, Math.round((r.end_at.getTime() - r.start_at.getTime()) / 60000)) : 0);
    minutes += m;
    perSite.set(r.site_id, (perSite.get(r.site_id) ?? 0) + m);
  }
  return { count: rows.length, minutes, perSite: [...perSite.entries()].map(([siteId, m]) => ({ siteId, minutes: m })) };
}
