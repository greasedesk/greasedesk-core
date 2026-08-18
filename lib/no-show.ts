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
