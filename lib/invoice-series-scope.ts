/**
 * File: lib/invoice-series-scope.ts
 *
 * WHICH INVOICES COUNT — one named rule per QUESTION, every series stated.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * "Which invoices count" was spelled `series: 'chargeable'` thirteen times across thirteen files.
 * That was fine while there were three series and the answer to every question happened to be the
 * same. The fourth series — a car sold out of stock — broke that: a sale invoice IS money owed, is
 * NOT workshop revenue, and counts for VAT only when the car was qualifying. Thirteen copies of one
 * literal could not say three different things, so each gave whichever answer it already had, and
 * two of them were wrong on the first sale. lib/credit-note.ts predicted it in a comment: "the day a
 * fourth series appears the rule is silently wrong."
 *
 * ── ONE RULE PER QUESTION, NEVER ONE SHARED YES/NO ──────────────────────────────────────────────
 *
 * These rules must not be collapsed into a single `isChargeable`. The answers genuinely differ — a
 * sale invoice is a debt and is not revenue — and collapsing them is how the next wrong answer
 * arrives: somebody "simplifies" two identical-looking rules, and the day they stop being identical
 * one of them is wrong without anyone having touched it. series-scope-gate asserts that the rules
 * which must disagree DO disagree.
 *
 * ── EVERY SERIES STATED ─────────────────────────────────────────────────────────────────────────
 *
 * Each rule is a Record over the series union, so a FIFTH series fails to compile here until every
 * question has been given an answer for it. A `not:` or a list naming only the included series
 * would let it arrive silently on whichever side the author did not think about.
 *
 * Still to move here, deliberately in later steps: the VAT return's output rule (step 3, which also
 * needs vat_position) and credit notes' declared-supply rule (step 4).
 */
import type { InvoiceSeriesName } from '@/lib/invoice-number';

export type SeriesRule = Readonly<Record<InvoiceSeriesName, boolean>>;

/**
 * CAN THIS INVOICE BE OWED? The unpaid and overdue lists, the debtors tile, and whether a due date is
 * written at all — one question, so one rule: an invoice that cannot be a debt gets no due date.
 *   chargeable    yes — workshop work
 *   vehicle_sale  yes — a car sold and not yet paid for is money owed
 *   warranty      no  — settles at £0
 *   historical    no  — paid under the previous system
 */
export const IS_DEBT: SeriesRule = { chargeable: true, warranty: false, historical: false, vehicle_sale: true };

/**
 * THE INVOICE LIST'S "ISSUED IN PERIOD": what was raised. An invoice is an invoice.
 * Warranty and historical keep their OWN list filters and are not part of this one.
 */
export const IN_ISSUED_LIST: SeriesRule = { chargeable: true, warranty: false, historical: false, vehicle_sale: true };

/**
 * THE DASHBOARD'S WORKSHOP TAKINGS: the Revenue, Issued-vs-paid and Pending-clearance tiles, and
 * lib/payments::receivedInPeriod behind them. NOT car sales — those tiles sit beside the profit
 * strip, and the paid side of Issued-vs-paid is written to equal Revenue exactly so one screen
 * cannot contradict itself. Car takings are shown on the stock page. When the invoice list is
 * opened FROM one of these tiles it is scoped to this rule, so a tile and its list still agree.
 */
export const IN_WORKSHOP_TAKINGS: SeriesRule = { chargeable: true, warranty: false, historical: false, vehicle_sale: false };

/**
 * THE WORKSHOP LEDGER behind the P&L strip, the effective hourly rate and capacity. A car sale is not
 * workshop revenue: its line is the car at full price with no trade cost, and in this ledger it raised
 * gross margin by the whole price (fixed in 9640f0b). Warranty stays — its parts cost is real drag.
 * Historical stays — imported work is the garage's own past.
 */
export const IN_WORKSHOP_LEDGER: SeriesRule = { chargeable: true, warranty: true, historical: true, vehicle_sale: false };

/**
 * HAS THE CHARGEABLE COUNTER BEEN USED? The settings guard that allows the starting number to be
 * seeded only while no chargeable invoice exists. Literally about that one counter — a car sale draws
 * from its own and must never lock the garage's numbering.
 */
export const USES_CHARGEABLE_COUNTER: SeriesRule = { chargeable: true, warranty: false, historical: false, vehicle_sale: false };

/**
 * IS THIS INVOICE EXPECTED TO MATCH THE PRICE AGREED ON ITS CARD? lib/invoice-issue::billingDivergence.
 * Only workshop work is quoted. Warranty settles at £0, historical was raised elsewhere, and a car is
 * never quoted — for a sale card this is one of two independent reasons divergence is null.
 */
export const TRACKS_AGREED_QUOTE: SeriesRule = { chargeable: true, warranty: false, historical: false, vehicle_sale: false };

/** Every rule, by name — for the gate, which pins each answer and checks each is total. */
export const SERIES_RULES = {
  IS_DEBT, IN_ISSUED_LIST, IN_WORKSHOP_TAKINGS, IN_WORKSHOP_LEDGER, USES_CHARGEABLE_COUNTER, TRACKS_AGREED_QUOTE,
} as const;

/** The series a rule includes. */
export function seriesIncluded(rule: SeriesRule): InvoiceSeriesName[] {
  return (Object.keys(rule) as InvoiceSeriesName[]).filter((k) => rule[k]);
}

/** A Prisma `where` fragment for a rule. */
export function seriesWhere(rule: SeriesRule): { series: { in: InvoiceSeriesName[] } } {
  return { series: { in: seriesIncluded(rule) } };
}

/**
 * The same rule over a value already in memory. FAILS CLOSED: a series string the union does not know
 * — a typo, or a value from a future migration this code has not met — is never counted.
 */
export function allows(rule: SeriesRule, series: string | null | undefined): boolean {
  return typeof series === 'string' && Object.prototype.hasOwnProperty.call(rule, series) && rule[series as InvoiceSeriesName] === true;
}
