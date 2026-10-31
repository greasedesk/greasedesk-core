/**
 * File: lib/affiliate-earnings.ts
 * THE FOUR FIGURES, COMPUTED ONCE. Earned, held, payable, paid — for the affiliate's own dashboard
 * and for the Engine Room row, from the same function.
 *
 * ── WHY IT IS ITS OWN MODULE ────────────────────────────────────────────────────────────────────
 * The arithmetic lived inside lib/affiliate-admin::listAffiliates, which is a LIST: it reads every
 * affiliate and shapes rows for an operator. The portal needs one affiliate's figures, and the
 * tempting thing is a second small sum beside it — at which point the Engine Room and the
 * affiliate's own screen can disagree about what we owe them. Two surfaces disagreeing about money
 * is the failure worth designing out, so the sum moved here and listAffiliates calls it.
 *
 * A pure function of rows and a clock: no database, no settings, nothing to stub. That is also what
 * lets a gate assert the ER and the portal produce IDENTICAL figures from the same ledger, rather
 * than asserting each against itself.
 */
import { rewardIsPayable, AFFILIATE_HOLD_DAYS, rewardPayableFrom } from '@/lib/affiliate';

/** The only columns the sum needs. Anything else on CommissionEntry is somebody else's business. */
export type LedgerEntry = { kind: string; amount_pennies: number; created_at: Date };

export type Earnings = {
  /** Accruals minus clawbacks. What the ledger says they have earned, net. */
  earnedPennies: number;
  /** Of that, what has matured past the hold and could be sent. Never negative. */
  payablePennies: number;
  /** Of that, what is still inside the hold. Never negative. */
  heldPennies: number;
  /**
   * WHAT WE HAVE ACTUALLY SENT. Zero, and `paidRecorded: false` beside it, until AffiliatePayout
   * exists (deferred to November with the payout-run screen).
   *
   * THE FLAG IS THE POINT. A bare 0 here is indistinguishable from a measured "nothing yet", and a
   * screen that prints "£0.00 paid" is making a claim about a record that does not exist. With the
   * flag, the dashboard says "no payouts yet" — which is TRUE today, because there is no mechanism
   * to pay through — and the day the table lands the sentence changes because the fact changed, not
   * because somebody noticed the zero was fiction.
   */
  paidPennies: number;
  paidRecorded: boolean;
};

/**
 * PAYABLE IS ABOUT THE ACCRUALS' OWN DATES, and clawbacks net off the total without having a hold
 * of their own to mature past: money going back is not money becoming sendable. Carried over from
 * listAffiliates unchanged, including both floors at zero.
 *
 * WHY THE FLOORS. A net-negative payable is a clawback waiting for the next accrual, which is what
 * the ledger means and not what "-£30 payable" reads as on a screen — that reads as a demand for
 * money from somebody who introduced us a garage.
 */
export function earningsFrom(entries: LedgerEntry[], now: Date = new Date()): Earnings {
  const earnedPennies = entries.reduce((n, e) => n + e.amount_pennies, 0);
  const maturedAccruals = entries
    .filter((e) => e.kind === 'accrual' && rewardIsPayable({ paidAt: e.created_at, now }))
    .reduce((n, e) => n + e.amount_pennies, 0);
  const clawbacks = entries.filter((e) => e.kind === 'clawback').reduce((n, e) => n + e.amount_pennies, 0);
  const payablePennies = Math.max(0, maturedAccruals + clawbacks);
  return {
    earnedPennies,
    payablePennies,
    heldPennies: Math.max(0, earnedPennies - payablePennies),
    paidPennies: 0,
    paidRecorded: false,
  };
}

/**
 * WHEN EACH HELD ACCRUAL BECOMES PAYABLE. The dashboard shows dates, and a total alone cannot say
 * "£30 of this arrives on the 12th" — which is the question somebody actually has when they look.
 *
 * Only accruals, and only the ones still inside the hold: a matured accrual has no date to wait for
 * and a clawback has no hold. Sorted soonest first, because that is the order a person reads.
 */
export function heldSchedule(entries: LedgerEntry[], now: Date = new Date()): Array<{ amountPennies: number; payableFrom: Date }> {
  return entries
    .filter((e) => e.kind === 'accrual' && !rewardIsPayable({ paidAt: e.created_at, now }))
    .map((e) => ({ amountPennies: e.amount_pennies, payableFrom: rewardPayableFrom(e.created_at) }))
    .sort((a, b) => a.payableFrom.getTime() - b.payableFrom.getTime());
}

export { AFFILIATE_HOLD_DAYS };
