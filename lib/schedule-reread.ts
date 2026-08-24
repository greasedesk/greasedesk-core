/**
 * File: lib/schedule-reread.ts
 * ONE-OFF: re-read a schedule mileage that was stored as a target when it was typed as a countdown.
 *
 * The capture form offered two conventions and nothing on the row said which had been meant. Every
 * mileage figure the live tenant recorded under it sits BELOW its own car's reading — 54 of 54 on
 * 2026-08-24 — which no real target does. They are intervals read off a cluster and stored as
 * though they were odometer positions: "due at 14,000 miles" about a car reading 117,735.
 *
 * PURE, so the rule can be proved without touching a tenant. The migration script and its gate call
 * the same function; the gate exercises it against ZZ fixtures end to end, and only then does the
 * script run against real data.
 *
 * NO INTERVAL CEILING. A first draft refused values over 30,000 as "implausible as an interval" and
 * flagged three rows — a 36,000-mile pad set and two long vehicle checks. That was a general
 * assumption applied to a particular fleet: those are ordinary MINI intervals, and the tenant is
 * MINI-heavy. The rule is the arithmetic, not a guess about how far a car goes between services.
 */

export type RereadRow = {
  id: string;
  due_mileage: number | null;
  countdown_miles: number | null;
};

export type RereadDecision =
  | { act: true; dueMileage: number; countdownMiles: number; mode: 'countdown'; from: { due_mileage: number | null; countdown_miles: number | null; mode: string | null } }
  | { act: false; reason: 'already_countdown' | 'no_target' | 'no_odometer' };

/**
 * The whole decision. `odometer` is the reading on the row's OWN card — odometer_out ?? odometer_in,
 * the same precedence the departure stage uses — never today's reading for that car, which has
 * moved since.
 *
 * REFUSES A ROW THAT ALREADY CARRIES A COUNTDOWN, which is what makes a second run a no-op rather
 * than a doubling: re-reading 68,542 against 67,542 again would store 136,084.
 */
export function rereadAsCountdown(
  row: RereadRow & { mode?: string | null },
  odometer: number | null,
): RereadDecision {
  if (row.countdown_miles != null) return { act: false, reason: 'already_countdown' };
  if (row.due_mileage == null) return { act: false, reason: 'no_target' };
  if (odometer == null) return { act: false, reason: 'no_odometer' };
  return {
    act: true,
    dueMileage: odometer + row.due_mileage,
    countdownMiles: row.due_mileage,
    mode: 'countdown',
    from: { due_mileage: row.due_mileage, countdown_miles: row.countdown_miles, mode: row.mode ?? null },
  };
}

/** The invariant every corrected row must satisfy: the pair recovers the odometer it came from. */
export const recoversOdometer = (dueMileage: number, countdownMiles: number, odometer: number): boolean =>
  dueMileage - countdownMiles === odometer;
