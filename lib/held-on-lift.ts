/**
 * File: lib/held-on-lift.ts
 * HELD ON LIFT — a car occupying a bay open-endedly, almost always awaiting parts. THE one
 * definition, because four readers ask about it and they ask three different questions:
 *
 *   the clash guard (lib/diary-booking)  may I put a car here?      → an UNBOUNDED query + refusal
 *   the day reader  (lib/diary-day)      what do I draw today?      → a second OR-arm
 *   the diary block (pages/admin/diary)  how long has it been?      → the tail + the day count
 *   the phone       (pages/m/index)      is this car waiting?       → the chip
 *
 * ── A HOLD IS NOT A STATUS, AND NOT A BOOLEAN ───────────────────────────────────────────────────
 * `held_since` is a nullable timestamp. The work has STARTED and is paused: that is a fact about an
 * `in_progress` card, not a lifecycle step, so it is not a JobStatus (which would have to be
 * answered for in six total-by-construction lists for a state that is not one). And it is a
 * timestamp rather than a boolean because "how long has that car been on bay two?" is the question
 * that actually gets asked, and nine days on a bay is money a boolean cannot name.
 *
 * ── WHY NOTHING "CLEARS" IT ON A TRANSITION ─────────────────────────────────────────────────────
 * The settled decision was "cleared on release, on unplace, and on any transition that frees the
 * slot". The first two are deliberate acts and do write NULL. The third cannot be written as code:
 * `jobCard.status` has NINE writers outside lib/jobcard-transition (quote acceptance, unmark-paid,
 * unlock, quote-send, a stage completion, a photo upload, three import paths), so a clearing
 * statement would have to be added to each and the tenth writer would leave a phantom hold forever
 * — which is precisely the failure the decision was guarding against.
 *
 * So the hold is DERIVED instead: `isHeld` is true only while the card is `in_progress`. Any door
 * out of `in_progress` ends the hold with no clearing code anywhere, and a phantom hold becomes
 * impossible rather than remembered. It also catches a case an enumeration of FREES_THE_SLOT would
 * have missed: `invoiced` does not free the slot by that list, yet invoicing plainly ends the hold.
 *
 * The timestamp is left in place when the card moves on, so "this car was held from the 2nd" stays
 * readable in history instead of having to be reconstructed from the audit log.
 */
import { calendarDayDiff } from '@/lib/calendar-days';
import type { JobStatus } from '@/lib/jobcard-status';
import { dayBands, type Break, type Segment } from '@/lib/occupancy';

/** The ONE status a hold is valid on. See the header: a hold is a fact about work in progress. */
export const HELD_STATUS: JobStatus = 'in_progress';

/** The two fields every reader needs. Loose types so a Prisma row, an API row and a page prop all fit. */
export type HeldFacts = { status?: string | null; held_since?: Date | string | null };

/**
 * THE Prisma where-shape for "this card is holding its bay". Exported as the ingredients rather
 * than a function because two of the readers are where-clauses, not calls — this way the predicate
 * below and the SQL cannot say different things. Spread it; never restate it.
 */
export const HELD_WHERE = { status: HELD_STATUS, held_since: { not: null } } as const;

/** Is this card holding its bay RIGHT NOW? The predicate form of HELD_WHERE. */
export function isHeld(card: HeldFacts | null | undefined): boolean {
  return !!card && !!card.held_since && card.status === HELD_STATUS;
}

/** The hold's start as an instant, or null — including when the card is no longer `in_progress`. */
export function heldSinceMs(card: HeldFacts | null | undefined): number | null {
  if (!isHeld(card)) return null;
  const v = card!.held_since!;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * HOW MANY DAYS IT HAS BEEN ON THE BAY — calendar days, so it agrees with what a person counts.
 * Held this morning is 0 and prints nothing; held yesterday afternoon is 1 and prints "1 day",
 * sixteen hours in, because "since yesterday" is what somebody standing next to the car says. An
 * elapsed-hours floor would print nothing for a car that has been there overnight, which is the
 * Monday-morning failure this whole slice exists to prevent, in miniature.
 */
export function heldDays(card: HeldFacts | null | undefined, now: Date): number | null {
  const ms = heldSinceMs(card);
  if (ms == null) return null;
  return Math.max(0, calendarDayDiff(new Date(ms), now));
}

/**
 * ── THE TAIL: WHAT THE DIARY DRAWS ──────────────────────────────────────────────────────────────
 * The working-hours segments a hold occupies within one day column. The hold has NO END, so:
 *
 *   before `held_since`      nothing — the booking's own footprint covers that
 *   the day it began         from `held_since` to close
 *   every later day          the whole working day, forward, with no end date
 *
 * It claims FORWARD deliberately. The alternative — stopping the hatch at now — leaves tomorrow's
 * column looking free on a bay that has a car bolted to it, and the drop there is then refused by
 * a guard the person could not see coming. A bay that looks free and is not is the exact failure
 * the owner named: met on a Monday morning, with a car in the way.
 *
 * Working-hours-bounded like every other footprint, through the same `dayBands`, so the renderer
 * gets segments it can actually place on a grid that only has opening hours on it.
 */
export function heldTailSegments(args: {
  card: HeldFacts;
  dayStartISO: string;   // midnight of the column being drawn (naive-UTC wall time, as elsewhere)
  openHour: number;
  closeHour: number;
  openDays: number[];
  breaks?: Break[];
  /**
   * The earliest instant the tail may start. The diary passes the BOOKING'S OWN END: up to there
   * the bay is already drawn in the card's status colour, and hatching over it would obscure the
   * block for the period the car was genuinely being worked on. A tail is what extends past the
   * plan, so it starts where the plan stops. Omitted, the tail starts at `held_since` — which is
   * what the engine means and what the clash guard asks about.
   */
  notBefore?: string;
}): Segment[] {
  const held = heldSinceMs(args.card);
  if (held == null) return [];
  const dayStart = Date.parse(args.dayStartISO);
  if (!Number.isFinite(dayStart)) return [];
  const midnight = Date.UTC(
    new Date(dayStart).getUTCFullYear(), new Date(dayStart).getUTCMonth(), new Date(dayStart).getUTCDate(),
  );
  if (!args.openDays || !args.openDays.includes(new Date(midnight).getUTCDay())) return [];

  const bands = dayBands(args.openHour * 60, args.closeHour * 60, args.breaks ?? []);
  if (bands.length === 0) return [];

  // Where the hold starts WITHIN this column: its own start on the day it began, opening otherwise.
  // A column entirely BEFORE the hold draws nothing, and it falls out of this one line rather than
  // an early return: a hold starting after this column's midnight+24h puts fromMin at 1440 or more,
  // while every band ends at closeHour*60 which is at most 1440, so the clip below skips them all.
  // There WAS an `if (held >= dayEnd) return []` here. It changed no answer — proved by removing it
  // (0 of 26 red) — and it was worse than redundant: with both present, neither mutation could make
  // "a day before the hold draws nothing" go red, because each line covered the other. Two defences
  // that hide each other leave the clause between them unproved.
  const notBefore = args.notBefore ? Date.parse(args.notBefore) : null;
  const from = Math.max(held, midnight, Number.isFinite(notBefore as number) ? (notBefore as number) : -Infinity);
  const fromMin = (from - midnight) / 60_000;

  const out: Segment[] = [];
  for (const [bStart, bEnd] of bands) {
    const s = Math.max(bStart, fromMin);
    if (s >= bEnd) continue;
    out.push({
      startISO: new Date(midnight + s * 60_000).toISOString(),
      endISO: new Date(midnight + bEnd * 60_000).toISOString(),
    });
  }
  return out;
}
