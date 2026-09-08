/**
 * File: lib/rep-visit.ts
 * WHEN A VISIT COUNTS. One pure module; every surface and the money read the same answer.
 *
 * A rep visit is what makes CommissionRate.amount_unvisited_pennies reachable — £12.50 against a
 * £30.00 full rate. NOTHING READS THAT COLUMN YET and this file does not change it: the rule lands
 * first, provably, and wiring it to the ledger is a later, deliberate slice. rep-visit-gate pins
 * both halves of that, so the dormancy is a checked fact rather than an intention.
 *
 * ── TWO CLAUSES, AND NEITHER IS ENOUGH ALONE ────────────────────────────────────────────────────
 * One visit per calendar month, AND at least fourteen days since the last one that counted.
 *   · month alone        — the 31st and the 1st are two calendar months and two consecutive days
 *   · fourteen days alone — the 1st, the 15th and the 29th are three visits inside one month
 *
 * ── EVERYTHING IS CIVIL, IN THE SITE'S ZONE ─────────────────────────────────────────────────────
 * "Calendar month" and "fourteen days" are things a person says while looking at a wall calendar,
 * so they are computed on CIVIL dates in Site.timezone — never on UTC digits and never on elapsed
 * milliseconds. Two consequences worth stating because both have bitten elsewhere:
 *   · 23:40 UTC on 31 March is 00:40 on 1 April in London. The same scan pays for a different month
 *     depending on the zone, which is why the period is frozen onto the row AT WRITE TIME. Deriving
 *     it at read means a later timezone edit silently moves which month a past visit paid for.
 *   · 29 March 2026 is a 23-hour day in London. Counting civil days makes that invisible; counting
 *     24-hour blocks comes up an hour short once a year, and 09:00→08:00 fourteen days later would
 *     read as thirteen.
 */

/** Days that must pass between visits that count. */
export const VISIT_MIN_DAYS = 14;

/** How a visit came to be recorded. Mirrored by RepVisit_source_chk in the database. */
export const VISIT_SOURCES = ['scan', 'operator'] as const;
export type VisitSource = (typeof VISIT_SOURCES)[number];

/**
 * WHY A VISIT THAT HAPPENED COULD NOT BE SCANNED — a code, not a sentence.
 *
 * It shipped as free prose, and RepVisit SURVIVES a tenant purge (it is the supporting document for
 * the commission ledger). So "Dave's tablet was flat" was a name we kept after an erasure. A value
 * from a closed set is the audit answer to "why was this not scanned?" and holds nothing about the
 * garage's people; anything a person wants to type goes to RepVisitNote, which goes with the tenant.
 *
 * ── EVERY VALUE IS A CASE WHERE THE REP WAS THERE ───────────────────────────────────────────────
 * That is the line, and it is why "the rep could not attend" and "the garage was closed" are NOT
 * here. A visit nobody attended is not a visit with a reason — it is a month with no visit, and
 * recording one would set satisfies_period and pay the full rate for a meeting that never happened.
 * If a wasted journey should ever be credited, that is a recorded ATTEMPT and a different thing
 * from evidence that somebody was seen; it wants its own shape rather than a value smuggled in here.
 *
 * ── AND THERE IS NO `other` ─────────────────────────────────────────────────────────────────────
 * The prose that would explain an `other` lives in RepVisitNote, which is erased with the tenant —
 * so `other` degrades to noise at exactly the moment the audit needs it. When a case does not fit,
 * the set is wrong and gets amended by a migration, the same deliberate act MarketingContact.reason
 * has twice made.
 */
export const UNSCANNED_REASONS = [
  'screen_unavailable',    // no working device to display the code — flat tablet, broken screen
  'no_one_could_sign_in',  // a device, but nobody on site who could sign in to show it
  'scan_failed',           // the code was displayed and the read did not complete
  'code_expired',          // displayed, but stale by the time it was read — the window was too tight
] as const;
export type UnscannedReason = (typeof UNSCANNED_REASONS)[number];

export type UnscannedRefusal = { code: 'reason_required' | 'bad_reason'; message: string };

/**
 * The reason and the source must agree. A scan IS the evidence, so a reason beside one is a
 * contradiction rather than extra detail; an operator-recorded visit has no evidence but the reason,
 * so it must carry one. RepVisit_evidence_chk holds the same pairing at the database.
 */
export function refuseUnscanned(source: string, reason: string | null | undefined): UnscannedRefusal | null {
  if (source === 'scan') {
    return reason == null ? null
      : { code: 'bad_reason', message: 'A scanned visit needs no reason — the scan is the evidence.' };
  }
  if (reason == null) return { code: 'reason_required', message: 'Say why this visit could not be scanned.' };
  return (UNSCANNED_REASONS as readonly string[]).includes(reason) ? null
    : { code: 'bad_reason', message: 'That is not one of the reasons this form offers.' };
}

/** A visit already on the record. `satisfies_period` NULL = a real visit that earned no month. */
export type PriorVisit = { scanned_at: Date; satisfies_period: string | null };

/**
 * Why a visit earns no month. NOT a rejection of the scan: the visit is still recorded, with
 * satisfies_period NULL. Refusing to record it would be recording less than happened, and the rep
 * who turned up twice would have their second call vanish.
 */
export type VisitRefusal =
  | { code: 'already_satisfied'; period: string; at: Date }
  /**
   * `earliestDay` is a CIVIL DATE, not an instant. The rule counts days in a zone, so the answer is
   * a day; handing back a Date would invent a time of day nobody decided.
   */
  | { code: 'too_soon'; daysSince: number; earliestDay: string };

const partsIn = (at: Date, timeZone: string): { y: number; m: number; d: number } => {
  // formatToParts rather than a formatted string: the numeric parts are named, so this does not
  // depend on an ICU locale happening to lay a date out in the order we expect.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
};

const pad = (n: number) => String(n).padStart(2, '0');

/** The civil date in `timeZone`, as 'YYYY-MM-DD'. */
export function civilDay(at: Date, timeZone: string): string {
  const { y, m, d } = partsIn(at, timeZone);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** The civil month in `timeZone`, as 'YYYY-MM'. This is what gets frozen onto the row. */
export function periodInZone(at: Date, timeZone: string): string {
  const { y, m } = partsIn(at, timeZone);
  return `${y}-${pad(m)}`;
}

/** Whole civil days since the epoch — the unit all the arithmetic below is done in. */
export function civilDayNumber(at: Date, timeZone: string): number {
  const { y, m, d } = partsIn(at, timeZone);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

const dayFromNumber = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** Whole civil days between two instants, in `timeZone`. Same day = 0. */
export function wholeDaysBetween(a: Date, b: Date, timeZone: string): number {
  return civilDayNumber(b, timeZone) - civilDayNumber(a, timeZone);
}

/**
 * Does this visit earn its month? `null` = yes.
 *
 * Only visits that COUNTED anchor the interval. A second visit in a month is recorded with
 * satisfies_period NULL and must not push the next month's window out, or a keen rep locks
 * themselves out by turning up twice.
 *
 * When both clauses bite, the MONTH is reported: "you have already been paid for June" tells the
 * rep something actionable, where "four days since the last one" leaves them to work it out.
 */
export function refuseVisit(args: { now: Date; timeZone: string; previous: PriorVisit[] }): VisitRefusal | null {
  const { now, timeZone, previous } = args;
  const period = periodInZone(now, timeZone);
  const counted = previous.filter((p) => p.satisfies_period !== null);

  const already = counted.find((p) => p.satisfies_period === period);
  if (already) return { code: 'already_satisfied', period, at: already.scanned_at };

  let last: PriorVisit | null = null;
  for (const p of counted) if (!last || p.scanned_at > last.scanned_at) last = p;
  if (last) {
    const daysSince = wholeDaysBetween(last.scanned_at, now, timeZone);
    if (daysSince < VISIT_MIN_DAYS) {
      return { code: 'too_soon', daysSince, earliestDay: dayFromNumber(civilDayNumber(last.scanned_at, timeZone) + VISIT_MIN_DAYS) };
    }
  }
  return null;
}

/**
 * Civil days the garage was active for within `period`, counting the activation day itself.
 *
 * INCLUSIVE, and the boundary is worth stating because February is where it shows: activating on
 * 15 February leaves the 15th to the 28th — fourteen days if you count the day you arrived, which
 * is what a person means by "I have been here a fortnight".
 *
 * `activation` NULL = nothing accrues at all (linesForPayment's trial gate), so there is no month
 * to be active in and the answer is zero rather than a whole month.
 */
export function activeDaysInMonth(activation: Date | null, period: string, timeZone: string): number {
  if (!activation) return 0;
  const [y, m] = period.split('-').map(Number);
  const lastDom = new Date(Date.UTC(y, m, 0)).getUTCDate();     // day 0 of the next month
  const monthFirst = Date.UTC(y, m - 1, 1) / 86_400_000;
  const monthLast = Date.UTC(y, m - 1, lastDom) / 86_400_000;
  const from = Math.max(civilDayNumber(activation, timeZone), monthFirst);
  if (from > monthLast) return 0;
  return monthLast - from + 1;
}

/**
 * Was a visit EXPECTED in this month at all?
 *
 * A month the garage was in for fewer than VISIT_MIN_DAYS could not have had one: the fourteen-day
 * clause makes it arithmetically impossible. Anchored on `activation` — the instant
 * lib/commission's trial gate already uses, so "when did they become chargeable" has one answer —
 * and it covers a tenant's final month without needing a second concept.
 *
 * ── IT USED TO PRICE SOMETHING. IT NOW ONLY DESCRIBES. ──────────────────────────────────────────
 * This was a PRICING rule: it stopped the reduced rate being charged for a month in which a visit
 * was impossible. There is no reduced rate — a garage-month is £30 or it is HELD — so it prices
 * nothing, and it survives as the predicate that gives the area manager's list its third state.
 * A garage that joined on the 28th showing as "no visit" beside nineteen real misses is twenty
 * conversations where there should be nineteen. See docs/rep-system.md §5.
 */
export function monthNeedsVisit(activation: Date | null, period: string, timeZone: string): boolean {
  return activeDaysInMonth(activation, period, timeZone) >= VISIT_MIN_DAYS;
}

/** What the manager's list shows against a garage for a month. Three states, not a boolean. */
export const VISIT_STATES = ['visited', 'not_visited', 'not_expected'] as const;
export type VisitState = (typeof VISIT_STATES)[number];

/**
 * The state to show for one garage-month.
 *
 * EVIDENCE BEATS EXPECTATION: a garage that was here for three days and STILL got a visit reads
 * `visited`, not `not_expected`. The exemption exists to stop a manager being asked about a month
 * nobody could have visited — not to hide a visit that happened.
 *
 * This decides nothing about money. Under the released model the manager may release an unvisited
 * month, and frequently will; `shown_as_visited` on the entry freezes which of these they saw.
 */
export function visitState(args: {
  activation: Date | null;
  period: string;
  timeZone: string;
  satisfied: boolean;
}): VisitState {
  if (args.satisfied) return 'visited';
  return monthNeedsVisit(args.activation, args.period, args.timeZone) ? 'not_visited' : 'not_expected';
}
