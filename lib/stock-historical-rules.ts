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
 * ── THE BOUNDARY IS A DATE, AND IT IS DECLARED ──────────────────────────────────────────────────
 *
 * The owner DECLARES it: "every car sale from today is invoiced through GreaseDesk". The date is STAMPED
 * with the day of the declaration, never typed — a typed date needs extra rules to stay safe, and a
 * future one leaves the back door open for months. It is written once and may move EARLIER only, which
 * narrows the door and can never reopen it. Until it is declared, historical entry is refused: to record
 * a past sale without an invoice you must first close the door on recording today's sale without one.
 *
 * THE EFFECTIVE BOUNDARY IS THE EARLIER of the declared date and the tenant's first car sale invoiced
 * here. That second limit stays because an invoiced sale made before the declaration still closes the
 * door behind it. Its date cannot move (lib/invoice-date-issued refuses a car sale) or be voided
 * (lib/invoice-void refuses a car sale).
 *
 * WHY NOT THE FIRST INVOICED SALE ALONE (the first design): it assumed the first invoiced sale comes
 * BEFORE the historical ones. On TMBS the history came first and the first invoiced sale was weeks away,
 * so the boundary blocked history on a sale not yet made. WHY NOT GO-LIVE: NU14KUF sold 7 July 2026,
 * after TMBS went live on 28 June — a go-live cutoff refuses a sale that plainly belongs here.
 *
 * ── IT NEVER REWRITES OWNERSHIP ─────────────────────────────────────────────────────────────────
 *
 * An owner whose record OVERLAPS the period we held the car — bought to sold — refuses, and is shown.
 * An owner whose record starts ON OR AFTER the sale is the car's later history and is the NORMAL case:
 * a buyer is entered as a customer when they first come back, dated that day, not the day they bought
 * it (NU14KUF: sold 7 July, its buyer's record starts 18 August). The entry adds beside that record and
 * changes nothing in it. The owner's first ruling refused these too; it was narrowed on 17 Sep 2026.
 */
import { SOURCES, VAT_STATUSES } from '@/lib/purchase-model';
import { isReacquisition } from '@/lib/stock-reacquisition';

const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** D Mon YYYY, by hand: the words are compared in gates and must not move with a runtime's ICU data. */
export const dayLabel = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

export const HISTORICAL_NO_BOUNDARY_REFUSAL =
  'Past sales can be recorded once you declare that every car sale from today is invoiced through '
  + 'GreaseDesk. Declaring stamps today’s date as the boundary: anything sold before it can be recorded '
  + 'as history, and anything from that date goes through “Sell this car”, which issues an invoice.';

/** What the declaration says, read back before it is made. The date is the day it is made — no choice. */
export const declarationSentence = (today: Date): string =>
  `From ${dayLabel(today)}, every car sale is invoiced through GreaseDesk. Sales before ${dayLabel(today)} can be `
  + 'recorded as history. This date can later be moved earlier, never later.';

export type Boundary = { date: Date; basis: 'declared' | 'first_invoice'; invoiceNumber: string | null; declared: Date };

/**
 * THE EFFECTIVE BOUNDARY: NULL until declared; otherwise the earlier of the declaration and the first
 * invoiced car sale. A tie goes to the declaration — the same day, and the one the owner stated.
 */
export function effectiveBoundary(declared: Date | null, firstInvoice: { date: Date; invoiceNumber: string } | null): Boundary | null {
  if (!declared) return null;
  if (firstInvoice && utcDay(firstInvoice.date) < utcDay(declared)) {
    return { date: firstInvoice.date, basis: 'first_invoice', invoiceNumber: firstInvoice.invoiceNumber, declared };
  }
  return { date: declared, basis: 'declared', invoiceNumber: null, declared };
}

/** Says WHICH limit set the date, so "why can I not enter this" has a findable answer. */
export const boundaryReason = (b: Boundary): string => (b.basis === 'first_invoice'
  ? `the date of your first car sale invoiced through GreaseDesk (${b.invoiceNumber})`
  : 'the date you declared every car sale from then on is invoiced through GreaseDesk');

export function boundaryRefusal(soldAt: Date, boundary: Boundary): string | null {
  if (utcDay(soldAt) < utcDay(boundary.date)) return null;
  return `This sale is dated ${dayLabel(soldAt)}, on or after ${dayLabel(boundary.date)} — ${boundaryReason(boundary)}. `
    + 'From that date every sale goes through “Sell this car”, which issues an invoice.';
}

/**
 * MOVING THE DECLARATION EARLIER — the only direction. Refused if it is not earlier, if it is in the future,
 * or if a sale already recorded as history would land on or after the new date: the door narrows around
 * what is already recorded, never through it.
 */
export function moveEarlierRefusal(a: { current: Date | null; proposed: Date | null; now: Date; recordedOnOrAfter: string[] }): string | null {
  if (!a.current) return 'Nothing has been declared yet, so there is nothing to move.';
  if (!a.proposed || Number.isNaN(a.proposed.getTime())) return 'Say the earlier date.';
  // "Only earlier" is asked FIRST: a later date that is also in the future is refused for the reason that
  // matters, not the incidental one.
  if (utcDay(a.proposed) >= utcDay(a.current)) {
    return `The boundary is ${dayLabel(a.current)} and can only move earlier. A later date would reopen the door to recording sales without an invoice.`;
  }
  if (utcDay(a.proposed) > utcDay(a.now)) return 'The boundary cannot be a future date.';
  if (a.recordedOnOrAfter.length) {
    return `Already recorded as history on or after ${dayLabel(a.proposed)}: ${a.recordedOnOrAfter.join(', ')}. The boundary cannot move past a sale already recorded.`;
  }
  return null;
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

export type OwnerEdge = { customerId: string; customerName: string; validFrom: Date; validTo: Date | null; isCurrent: boolean };

/**
 * AN OWNER WHOSE RECORD OVERLAPS THE PERIOD WE HELD THE CAR — bought (inclusive) to sold (exclusive).
 * Ended on or before the purchase day: the car's past, perhaps who we bought it from. Starting on or after
 * the sale day: the car's later history, usually our buyer entered when they came back. Anything between
 * says somebody else owned the car while we did, and that is a conflict to show, not to overwrite.
 */
export function ownershipConflicts(edges: OwnerEdge[], acquiredAt: Date, soldAt: Date): OwnerEdge[] {
  return edges.filter((e) => utcDay(e.validFrom) < utcDay(soldAt)
    && (e.validTo === null || utcDay(e.validTo) > utcDay(acquiredAt)));
}

/** Owners from the sale day onwards, earliest first — the records a past sale is added BESIDE. */
export function laterOwners(edges: OwnerEdge[], soldAt: Date): OwnerEdge[] {
  return edges.filter((e) => utcDay(e.validFrom) >= utcDay(soldAt))
    .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
}

/**
 * WHAT OWNERSHIP RECORD A PAST SALE ADDS, given who bought it and who GreaseDesk already knows owns it later.
 *  · no buyer named                      → nothing
 *  · the buyer IS a later owner          → nothing: their record stands as it is, start date included
 *  · a later owner who is someone else   → the buyer from the sale day, ENDED the day that owner's record starts
 *  · no later owner                      → the buyer from the sale day, current
 */
export type OwnershipWrite = { kind: 'none'; why: 'no_buyer' | 'buyer_already_owner' } | { kind: 'ended'; validTo: Date } | { kind: 'current' };
export function ownershipWrite(buyerCustomerId: string | null, later: OwnerEdge[]): OwnershipWrite {
  if (!buyerCustomerId) return { kind: 'none', why: 'no_buyer' };
  if (later.some((e) => e.customerId === buyerCustomerId)) return { kind: 'none', why: 'buyer_already_owner' };
  if (later.length) return { kind: 'ended', validTo: later[0].validFrom };
  return { kind: 'current' };
}

export function ownershipRefusal(conflicts: OwnerEdge[]): string {
  const lines = conflicts.map((e) => `${e.customerName}, from ${dayLabel(e.validFrom)}`
    + (e.validTo ? ` to ${dayLabel(e.validTo)}` : ' and still current'));
  return 'GreaseDesk already records this car with an owner during the time you held it: '
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
