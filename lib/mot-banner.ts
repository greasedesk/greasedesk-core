/**
 * File: lib/mot-banner.ts
 *
 * IS THIS CAR LEGAL TO DRIVE TO ME, ON THE DAY IT IS COMING?
 *
 * Pure, and ONE function for both surfaces — the job-card form and the diary's create form. The diary
 * is where the booking decision is made and the card is where the data is richest, but a car that is
 * fine on one screen and warned about on the other would teach a person to trust neither.
 *
 * ── THE REFERENCE DATE IS THE BOOKING, NOT TODAY ────────────────────────────────────────────────
 *
 * This is the case that caused the feature: a car booked for next week whose MOT expired on 28
 * August. Judged against today it may be fine; judged against the day it arrives it cannot legally be
 * driven here. So a banner reads against the BOOKING date whenever there is one — and SAYS WHICH IT
 * USED, because a reader who thinks it means "today" when it means "next Tuesday" is worse off than
 * with no banner at all.
 *
 * ── THE FOUR STORED STATES, WHICH ALREADY EXIST ─────────────────────────────────────────────────
 *
 * mot_checked_at means DVSA ANSWERED; a failed lookup writes nothing at all (lib/dvsa::motClientWrite
 * returns null on a null response). So the pair separates cleanly, and measured on a real tenant:
 *
 *   checked + expiry   DVSA answered, the car has an MOT                     256 of 276
 *   checked + NO expiry DVSA answered and there is NO MOT on record           12  — all 2023-25 cars
 *   not checked + expiry  typed or legacy, never verified                      6
 *   not checked + nothing nobody has ever asked                                2
 *
 * NO BANNER MUST NEVER READ AS "MOT IS FINE". Three of those four are absences with different causes
 * and different remedies, so each gets its own words, and the one that means "nobody has looked" gets
 * a BUTTON rather than better wording — the remedy for not having asked is to ask.
 */

/** Four weeks. The window in which it is worth doing while the car is already in. */
export const MOT_SOON_DAYS = 28;

/** A car's first MOT falls due three years after it is first registered. */
const FIRST_MOT_YEARS = 3;

export type MotBannerInput = {
  motExpiry: Date | string | null;
  motCheckedAt: Date | string | null;
  /** DVLA/DVSA year — approximate, and the only age signal most cars have. */
  year?: number | null;
  /** Exact, when captured. Present on almost nothing outside stock intake today. */
  firstRegistered?: Date | string | null;
};

export type MotBanner =
  | { kind: 'none' }
  | { kind: 'expired'; expiry: Date; days: number; against: 'booking' | 'today'; asOf: Date }
  | { kind: 'due_soon'; expiry: Date; days: number; against: 'booking' | 'today'; asOf: Date }
  | { kind: 'no_mot_probably_new'; reason: string }
  | { kind: 'no_mot_unknown'; reason: string }
  | { kind: 'never_checked'; reason: string };

const asDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Whole days between two calendar days — floored, date-based, like every other day count here. */
const dayDiff = (from: Date, to: Date): number => {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((b - a) / 86_400_000);
};

/**
 * WHICH BANNER, AND AGAINST WHICH DAY.
 *
 * `bookingAt` is the day the car is coming. Absent — an unbooked card — falls back to today, and the
 * returned `against` says which was used so the surface can print it. The caller never decides;
 * printing "today" over a booking-date judgement is the failure this field prevents.
 */
export function motBanner(
  v: MotBannerInput,
  now: Date,
  bookingAt?: Date | string | null,
): MotBanner {
  const booking = asDate(bookingAt ?? null);
  // A booking in the PAST is not the question being asked — a card being written up after the visit
  // should read against today, not against a day that has been and gone.
  const useBooking = !!booking && dayDiff(now, booking) > 0;
  const asOf = useBooking ? (booking as Date) : now;
  const against: 'booking' | 'today' = useBooking ? 'booking' : 'today';

  const expiry = asDate(v.motExpiry);
  const checked = asDate(v.motCheckedAt);

  if (expiry) {
    const days = dayDiff(asOf, expiry);
    if (days < 0) return { kind: 'expired', expiry, days: -days, against, asOf };
    if (days <= MOT_SOON_DAYS) return { kind: 'due_soon', expiry, days, against, asOf };
    return { kind: 'none' };
  }

  if (!checked) {
    // NOT "no MOT" — nobody has asked. The remedy is a lookup, and the surface offers one.
    return {
      kind: 'never_checked',
      reason: 'Nobody has looked this car up with DVSA, so we do not know whether it has an MOT.',
    };
  }

  // DVSA answered and there are no tests. Usually a car too new to need one — every such car on the
  // tenant this was built for was 2023 or later — but "usually" is not a thing to print as fact.
  const firstReg = asDate(v.firstRegistered ?? null);
  if (firstReg) {
    const due = new Date(Date.UTC(
      firstReg.getUTCFullYear() + FIRST_MOT_YEARS, firstReg.getUTCMonth(), firstReg.getUTCDate(),
    ));
    if (dayDiff(asOf, due) > 0) {
      return {
        kind: 'no_mot_probably_new',
        reason: `DVSA has no MOT for this car. It was first registered on ${firstReg.toISOString().slice(0, 10)}, `
          + `so its first MOT is not due until ${due.toISOString().slice(0, 10)}.`,
      };
    }
    return {
      kind: 'no_mot_unknown',
      reason: `DVSA has no MOT for this car, and its first one was due on ${due.toISOString().slice(0, 10)}. `
        + 'That needs checking before it is driven here.',
    };
  }
  if (typeof v.year === 'number' && v.year >= asOf.getUTCFullYear() - FIRST_MOT_YEARS) {
    return {
      kind: 'no_mot_probably_new',
      // HEDGED ON PURPOSE. A year is not a date: a car registered in January 2023 was due its first
      // MOT in January 2026 and one registered that December is not due until December. With only the
      // year we cannot tell those apart, so the sentence must not pretend we can.
      reason: `DVSA has no MOT for this car. It is a ${v.year}, so it may not be due one yet — `
        + 'though the exact date depends on when it was first registered.',
    };
  }
  return {
    kind: 'no_mot_unknown',
    reason: 'DVSA answered and has no MOT for this car, and we cannot tell why from what we hold. '
      + 'Worth checking before it is driven here.',
  };
}

/** Which day the judgement was made against, in words. Printed on every dated banner. */
export const againstLabel = (b: { against: 'booking' | 'today'; asOf: Date }): string =>
  b.against === 'booking'
    ? `judged against the booking on ${b.asOf.toISOString().slice(0, 10)}, not today`
    : 'judged against today';
