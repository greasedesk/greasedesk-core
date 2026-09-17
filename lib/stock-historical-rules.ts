/**
 * File: lib/stock-historical-rules.ts
 *
 * RECORDING A CAR SOLD BEFORE GREASEDESK INVOICED CAR SALES — the rules and the words, no database, so
 * the entry screen and the writer (lib/stock-historical) read one decision.
 *
 * ── WHAT A HISTORICAL SALE IS ───────────────────────────────────────────────────────────────────
 *
 * A RECORD, NOT A DOCUMENT. The buyer already holds the garage's receipt from the time; that receipt's
 * number is kept, and no GreaseDesk number is minted — no sale card, no invoice, no counter. It exists
 * so the sold dashboard and the stock book hold real history.
 *
 * It is NOT the `historical` invoice series. That series is for imported workshop work and is counted
 * in the P&L on purpose; a car sale there would put its price into workshop revenue.
 *
 * ── THE BOUNDARY IS A DATE ──────────────────────────────────────────────────────────────────────
 *
 * The date of the tenant's FIRST car sale invoiced through GreaseDesk. Before it, a sale is history;
 * on or after it, every sale goes through "Sell this car", which mints. DERIVED, never stored: that
 * invoice's date cannot move (lib/invoice-date-issued refuses a car sale) and it cannot be voided
 * (lib/invoice-void refuses a car sale), so there is no second copy of the boundary to drift. Until
 * that first sale exists there is no boundary, and historical entry is refused outright — otherwise
 * this would be a way to sell a car today without an invoice.
 *
 * ── IT NEVER REWRITES OWNERSHIP ─────────────────────────────────────────────────────────────────
 *
 * If GreaseDesk already records the car with an owner from any time after we bought it — the buyer
 * brought it back for a service, or somebody else owns it now — the entry refuses and SHOWS what is
 * there. History is added beside the present, never over it.
 */
import { SOURCES, VAT_STATUSES } from '@/lib/purchase-model';
import { isReacquisition } from '@/lib/stock-reacquisition';

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** D Mon YYYY, by hand: the words are compared in gates and must not move with a runtime's ICU data. */
export const dayLabel = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

export const HISTORICAL_NO_BOUNDARY_REFUSAL =
  'Past sales can be recorded once your first car sale has been invoiced through GreaseDesk. That '
  + 'sale’s date is the boundary: anything sold before it is history, and anything on or after it goes '
  + 'through “Sell this car”, which issues an invoice.';

export function boundaryRefusal(soldAt: Date, boundary: { date: Date; invoiceNumber: string }): string | null {
  if (utcDay(soldAt) < utcDay(boundary.date)) return null;
  return `This sale is dated ${dayLabel(soldAt)}, on or after ${dayLabel(boundary.date)} — the date of your `
    + `first car sale invoiced through GreaseDesk (${boundary.invoiceNumber}). From that date every sale goes `
    + 'through “Sell this car”, which issues an invoice.';
}

export const HISTORICAL_REACQUISITION_REFUSAL =
  'A car that came back to you — a return or a buyback — cannot be recorded as a past sale here. Its '
  + 'earlier sale has to exist first, and this entry would be inventing one.';

/** The cheap refusals: money, dates, and the two choices that decide the VAT. No database. */
export function historicalBasicsRefusal(a: {
  registration: unknown; acquiredAt: unknown; soldAt: unknown; purchasePence: unknown; salePence: unknown;
  vatStatus: unknown; source: unknown; now?: Date;
}): string | null {
  if (typeof a.registration !== 'string' || a.registration.trim().length < 2) return 'Type the registration.';
  const acquired = a.acquiredAt instanceof Date && !Number.isNaN(a.acquiredAt.getTime()) ? a.acquiredAt : null;
  const sold = a.soldAt instanceof Date && !Number.isNaN(a.soldAt.getTime()) ? a.soldAt : null;
  if (!acquired) return 'Say when you bought it.';
  if (!sold) return 'Say when you sold it.';
  if (utcDay(sold) < utcDay(acquired)) return 'A car cannot be sold before it was bought.';
  if (utcDay(sold) > utcDay(a.now ?? new Date())) return 'A past sale cannot be dated in the future.';
  const purchase = Number(a.purchasePence);
  if (!Number.isInteger(purchase) || purchase <= 0) return 'Say what you paid for it.';
  const sale = Number(a.salePence);
  if (!Number.isInteger(sale) || sale <= 0) return 'Say what it sold for.';
  if (!(VAT_STATUSES as readonly string[]).includes(String(a.vatStatus))) {
    return 'Say whether this car was on the margin scheme or VAT qualifying.';
  }
  if (!(SOURCES as readonly string[]).includes(String(a.source))) return 'Say where the car came from.';
  if (isReacquisition(a.source)) return HISTORICAL_REACQUISITION_REFUSAL;
  return null;
}

export type OwnerEdge = { customerName: string; validFrom: Date; validTo: Date | null; isCurrent: boolean };

/**
 * ANY OWNER GREASEDESK HOLDS FOR THIS CAR FROM THE DAY WE BOUGHT IT ONWARDS. An owner whose record
 * ended on or before the purchase is the car's past and does not conflict — that may even be who we
 * bought it from. Anything current, or reaching past the purchase date, is the present, and a
 * historical entry does not get to rewrite it.
 */
export function ownershipConflicts(edges: OwnerEdge[], acquiredAt: Date): OwnerEdge[] {
  return edges.filter((e) => e.isCurrent || e.validTo === null || utcDay(e.validTo) > utcDay(acquiredAt));
}

export function ownershipRefusal(conflicts: OwnerEdge[]): string {
  const lines = conflicts.map((e) => `${e.customerName}, from ${dayLabel(e.validFrom)}`
    + (e.validTo ? ` to ${dayLabel(e.validTo)}` : ' and still current'));
  return 'GreaseDesk already records this car with an owner after you bought it: '
    + `${lines.join('; ')}. A past sale never rewrites ownership. Check that record first — if it is `
    + 'wrong, correct it there, then record the sale.';
}

/** Two periods of owning the same car cannot overlap. */
export type HeldPeriod = { acquiredAt: Date; disposedAt: Date | null };
export function overlapsHeld(held: HeldPeriod[], acquiredAt: Date, soldAt: Date): HeldPeriod | null {
  return held.find((h) => h.disposedAt === null
    || (utcDay(h.acquiredAt) <= utcDay(soldAt) && utcDay(h.disposedAt) >= utcDay(acquiredAt))) ?? null;
}

export const HELD_OVERLAP_REFUSAL =
  'GreaseDesk already records this car in your stock over those dates. The same car cannot be held twice '
  + 'at once — check its stock record first.';
