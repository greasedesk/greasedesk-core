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
// TYPE-ONLY, AND IT MATTERS. lib/mot-refresh is imported by the diary and by
// lib/vehicle-lookup-client, both of which run in the browser; lib/dvsa is server-only and reads
// credentials. A value import here would drag it into the client bundle (see client-bundle-gate).
import type { DvsaFailure } from '@/lib/dvsa';

export type RefreshKind = 'changed' | 'unchanged' | 'no_answer';

export type RefreshOutcome = {
  kind: RefreshKind;
  /**
   * WHICH failure produced a `no_answer` — null on every answer.
   *
   * `kind` says whether anything was learned; this says why not. They are separate because a caller
   * deciding whether to stamp a column wants the first and a person deciding whether to press the
   * button again wants the second: `rate_limited` means wait, `forbidden` means nobody's lookup will
   * work until it is fixed, and `not_found` means stop pressing.
   */
  failure: DvsaFailure | null;
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
 * WHAT TO SAY FOR EACH FAILURE — one sentence each, and each one names the NEXT MOVE.
 *
 * All of these used to be the single sentence below ("DVSA didn’t answer"), which was accurate and
 * useless: it is true of a spent rate-limit window, a plate DVSA has never heard of, and a
 * credential nobody has set, and those are three different afternoons. The ruling asked for the
 * reason to travel with the null; this is where the reason becomes something a garage can read.
 *
 * EVERY ONE OF THEM SAYS NOTHING WAS LEARNED, except `not_found`, where something WAS: DVSA has no
 * record of the plate. That one still does not stamp mot_checked_at — the stamp means DVSA answered
 * about the MOT, and a car it cannot find has no MOT answer to give. Stamping it would flip the
 * banner to "DVSA says this car has no MOT" off a call that found no car at all.
 */
export function failureSentence(reason: DvsaFailure | null | undefined): string {
  switch (reason) {
    case 'not_found':
      return 'DVSA has no MOT record for this registration — check the plate.';
    case 'rate_limited':
      // THE ONE THE SHARED KEY MAKES LIKELY. Says "wait", because the next press will fail too.
      return 'DVSA is rate-limiting us — nothing was learned. Try again in a few minutes.';
    case 'forbidden':
      return 'Our DVSA access was refused — nothing was learned. This needs fixing here, not retrying.';
    case 'timeout':
      return 'DVSA didn’t answer in time — nothing was learned, so the date below is as old as it was.';
    case 'unavailable':
      return 'DVSA is unavailable — nothing was learned, so the date below is as old as it was.';
    case 'malformed':
      return 'DVSA answered with something we couldn’t read — nothing was learned.';
    case 'unconfigured':
      return 'MOT checks aren’t set up on this system — nothing was learned.';
    case 'no_registration':
      return 'No registration to check.';
    default:
      // A caller that did not name a reason. Kept word-for-word as it was, so an un-migrated path
      // reads exactly as it did before rather than inventing a diagnosis it does not have.
      return 'DVSA didn’t answer — nothing was learned, so the date below is as old as it was.';
  }
}

/**
 * @param answered  did DVSA respond at all — NOT whether anything changed
 * @param failure   which failure, when answered is false; null otherwise
 * @param heldBefore  the expiry we held going in, ISO or null
 * @param heldAfter   the expiry we hold coming out, ISO or null
 * @param stillDue    motBand(after) !== null — computed by the caller from the shared rule
 */
export function refreshOutcome(args: {
  answered: boolean;
  failure?: DvsaFailure | null;
  heldBefore: string | null;
  heldAfter: string | null;
  stillDue: boolean;
}): RefreshOutcome {
  const { answered, failure, heldBefore, heldAfter, stillDue } = args;

  if (!answered) {
    return {
      kind: 'no_answer',
      failure: failure ?? null,
      // NAMES THE DATE AS UNCHANGED rather than saying nothing, because silence here reads as
      // confirmation. The row keeps whatever it had, and says that is what it kept. Which sentence
      // is failureSentence's business, so this surface and the next cannot word it differently.
      sentence: failureSentence(failure),
      expiry: heldBefore,
      stillDue: true, // unchanged data cannot have changed the band
    };
  }

  if (heldAfter && heldAfter !== heldBefore) {
    return {
      kind: 'changed',
      failure: null,
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
    failure: null,
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

/**
 * ── THE ONE LINE A LOOK-UP ALWAYS LEAVES BEHIND ─────────────────────────────────────────────────
 * LC09XFU is why this exists. Its MOT had been verified at 09:23 and runs to 6 October 2027, and
 * pressing Look up said NOTHING: the banner is silent by design when an MOT is more than 28 days
 * out (lib/mot-banner returns `kind:'none'`), and the refresh line only rendered when a refresh had
 * run — which it correctly had not, the stamp being hours old. Two deliberate silences stacked up
 * and the screen could not be told apart from a broken feature. It was reported as one.
 *
 * So after ANY look-up there is exactly one line, and it answers the two questions a person has:
 * when was this last checked, and what is it valid to. Success is no longer indistinguishable from
 * nothing having happened.
 *
 * It takes what we HOLD, not what a call returned, which is what lets it speak for the press that
 * made no call at all. `failure` is set only when a check ran and did not answer, and it wins —
 * there is no honest way to print a date's age beside "we could not reach DVSA".
 */
export function motLookupLine(args: {
  /** The expiry we now hold, ISO. */
  expiry: string | null;
  /** The stamp we now hold — ours or the one this press just wrote. */
  checkedAt: Date | string | null;
  /** Set only when a check RAN and did not answer. */
  failure: DvsaFailure | null;
  now: Date;
}): string {
  const { expiry, checkedAt, failure, now } = args;
  // A FAILED CHECK OUTRANKS EVERYTHING. The stamp is whatever it was; saying how old it is beside
  // a failure invites the reading that the failure refreshed it.
  if (failure) return failureSentence(failure);

  const when = checkedLabel(checkedAt, now);
  // NEVER CHECKED, AND NO CHECK RAN. Reachable when a car is fresh by a stamp we cannot parse, or
  // on a DVSA-branch hit for a car we do not hold. Says the state rather than guessing at a date.
  if (!when) return 'Not checked with DVSA yet.';
  const cap = when.charAt(0).toUpperCase() + when.slice(1);

  // ANSWERED ABOUT A CAR WITH NO MOT. Distinct from "not checked": we asked, and this is the answer.
  if (!expiry) return `${cap} — no MOT recorded at DVSA.`;

  // "VALID TO" IS A CLAIM ABOUT THE FUTURE and must not be made about a past date. Compared on the
  // ISO day string against the same day boundary everything else here uses (lib/calendar-days), so
  // a date expiring today reads as valid today rather than as expired.
  const expired = calendarDayDiff(new Date(`${expiry}T00:00:00.000Z`), now) > 0;
  return expired
    ? `${cap} — MOT expired ${britishDate(expiry)}.`
    : `${cap} — MOT valid to ${britishDate(expiry)}.`;
}
