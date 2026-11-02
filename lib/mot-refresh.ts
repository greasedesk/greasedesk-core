/**
 * File: lib/mot-refresh.ts
 * WHAT TO SAY AFTER CHECKING A CAR'S MOT WITH DVSA — three outcomes, three sentences.
 *
 * ── WHY THIS IS A FUNCTION AND NOT THREE STRINGS IN A COMPONENT ─────────────────────────────────
 * The row on the marketing page is pressed immediately before someone rings a customer. What it
 * says is acted on within the minute, so the words are the feature and they are worth asserting
 * without a browser. Shaped like lib/send-outcome (skipCode → sentence + a flag the caller acts
 * on) for the same reason: the mapping is the rule, and the rule belongs in one place.
 *
 * ── THE THIRD OUTCOME IS THE ONE THIS EXISTS FOR ────────────────────────────────────────────────
 * "Checked just now" after a lookup that never answered would tell a garage the date is confirmed
 * when nothing was learned — on a screen they are about to act on. DVSA returns null for a 404, a
 * 403, a 429, a timeout and a missing credential alike; none of those are news about the car. So
 * `no_answer` is its own outcome, it says so, and it does NOT stamp mot_checked_at. A row's
 * "checked 09:12" is a fact about data we received, never about a button someone pressed.
 *
 * ── AND IT SAYS THE DAY, NOT THE MONTH ──────────────────────────────────────────────────────────
 * lib/due-items prints "November 2026" for a service interval, and that rule exists because the
 * day was NEVER KNOWN — a service computer says a month, and "1 November 2026" would be a day we
 * invented to fit a DateTime column. It is not a general preference for less precision.
 *
 * An MOT expiry is a real day DVSA states. Printing "July 2027" here would throw away a fact we
 * hold, which is the opposite failure to the one that rule prevents. Same principle, both
 * directions: say exactly what is known, and no more.
 */

// ── IS WHAT WE HOLD EVIDENCE ABOUT TODAY? ───────────────────────────────────────────────────────
/**
 * A FOURTH WINDOW, ON A DIFFERENT AXIS FROM THE OTHER THREE.
 *
 * lib/mot-banner declares three — MOT_SOON_DAYS 28, MOT_URGENT_DAYS 7, WINDOW_DAYS 30 — and says
 * they live together because all three are statements about how CLOSE an MOT is. This one is not:
 * it is about how OLD our evidence is. A reader who finds it beside those three and assumes it is a
 * fourth proximity rule has the wrong idea of it, so it lives here, in the module about refreshing,
 * with a pointer left there.
 *
 * SEVEN DAYS. Any stored MOT date is stale the moment it is stored — the car can be tested anywhere
 * and we hear about it only when we look (pages/api/mot-refresh says so at the top). So this is not
 * "how long a date stays true", which is no time at all; it is how long ago a check can have been
 * and still be worth more than another call to DVSA.
 *
 * It is also the ONLY throttle on the diary's lookup. One shared DVSA key serves every tenant with
 * no cache, no rate limit and no cap of our own, and a 429 comes back indistinguishable from an
 * unknown registration. A window of a week means pressing Look up on the same car four times in an
 * afternoon costs one call, not four, and that property is the reason this is a window at all
 * rather than "refresh on every records hit".
 */
export const MOT_CHECK_FRESH_DAYS = 7;

/**
 * WHY we would ask DVSA about this car — or null, meaning don't.
 *
 * THREE STATES AND NOT TWO, because the two reasons are not the same thing to a reader and will not
 * stay the same thing to a caller. `never_checked` is the row nobody has ever asked about: typed or
 * imported, and the banner already has its own words and its own button for it. `stale` is a row we
 * did verify, just not recently enough for it to be evidence about today. A boolean would make the
 * daily sweep — which wants to treat those two differently, one being a backlog and the other a
 * rotation — re-derive the distinction from the columns it was handed.
 *
 * A LOOKUP THAT FAILED LEAVES mot_checked_at ALONE (lib/dvsa::motClientWrite), so "checked" here
 * always means DVSA answered, and the age of that stamp is the age of real evidence. That is the
 * whole reason this can be a one-column rule.
 */
export type MotCheckReason = 'never_checked' | 'stale';

export function motCheckReason(
  v: { motCheckedAt: Date | string | null | undefined },
  now: Date,
  freshDays: number = MOT_CHECK_FRESH_DAYS,
): MotCheckReason | null {
  const raw = v?.motCheckedAt;
  if (!raw) return 'never_checked';
  const d = raw instanceof Date ? raw : new Date(raw);
  // AN UNREADABLE STAMP IS NOT A FRESH ONE. A column that cannot be parsed tells us nothing about
  // when we last looked, and the safe reading of "nothing" is that nobody has.
  if (!Number.isFinite(d.getTime())) return 'never_checked';
  // Day-grained, like every other day count here (lib/calendar-days), and FUTURE-TOLERANT: a stamp
  // ahead of now is clock skew, not evidence from tomorrow, and must not read as stale.
  const age = calendarDayDiff(d, now);
  return age > freshDays ? 'stale' : null;
}

import { calendarDayDiff } from '@/lib/calendar-days';

export type RefreshKind = 'changed' | 'unchanged' | 'no_answer';

export type RefreshOutcome = {
  kind: RefreshKind;
  /** What the row says. The whole sentence, so no caller assembles a second version of it. */
  sentence: string;
  /** The expiry we now hold, ISO, for the row to render struck-through against the old one. */
  expiry: string | null;
  /** Whether the car is STILL on this list — from motBand, so the band rule is not re-derived. */
  stillDue: boolean;
};

const britishDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/**
 * @param answered  did DVSA respond at all — NOT whether anything changed
 * @param heldBefore  the expiry we held going in, ISO or null
 * @param heldAfter   the expiry we hold coming out, ISO or null
 * @param stillDue    motBand(after) !== null — computed by the caller from the shared rule
 */
export function refreshOutcome(args: {
  answered: boolean;
  heldBefore: string | null;
  heldAfter: string | null;
  stillDue: boolean;
}): RefreshOutcome {
  const { answered, heldBefore, heldAfter, stillDue } = args;

  if (!answered) {
    return {
      kind: 'no_answer',
      // NAMES THE DATE AS UNCHANGED rather than saying nothing, because silence here reads as
      // confirmation. The row keeps whatever it had, and says that is what it kept.
      sentence: 'DVSA didn’t answer — nothing was learned, so the date below is as old as it was.',
      expiry: heldBefore,
      stillDue: true, // unchanged data cannot have changed the band
    };
  }

  if (heldAfter && heldAfter !== heldBefore) {
    return {
      kind: 'changed',
      sentence: stillDue
        ? `MOT now expires ${britishDate(heldAfter)} — still due.`
        : `MOT renewed to ${britishDate(heldAfter)} — no longer due.`,
      expiry: heldAfter,
      stillDue,
    };
  }

  return {
    // SAYS WHAT WAS CHECKED, not merely that something was. A bare "no change" beside a row
    // carrying a date, a mileage and a customer does not say which of them was confirmed.
    kind: 'unchanged',
    sentence: 'Checked just now — MOT date unchanged.',
    expiry: heldBefore,
    stillDue,
  };
}

/**
 * "checked 09:12" on the day, "checked 19 Aug" after it.
 *
 * A relative age ("2 hours ago") would be the friendlier phrasing and the wrong one: the question
 * this answers is "has my colleague already done this one", and a clock time is what someone
 * compares against their own morning. Null means never — and renders nothing, because "never
 * checked" is the state of most of the fleet and is not news.
 */
export function checkedLabel(checkedAt: Date | string | null, now: Date): string | null {
  if (!checkedAt) return null;
  const d = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  if (!Number.isFinite(d.getTime())) return null;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay
    ? `checked ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : `checked ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}
