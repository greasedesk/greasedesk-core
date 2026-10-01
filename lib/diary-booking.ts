/**
 * File: lib/diary-booking.ts
 * THE single place a job card is placed on a resource, with the double-booking guard — now
 * OCCUPANCY-FOOTPRINT aware. A booking's WORKING duration (minutes) is the source of truth; the
 * footprint (per-day working-hours segments, wrapping past close onto the next OPEN day) is derived
 * via lib/occupancy. The guard checks the FULL footprint against other bookings' footprints on the
 * same resource, so a job that spills onto a later day can no longer hide a clash there.
 *
 * Used by /api/diary, /api/jobcard-accept and /api/jobcard so there is one guard, never a copy. Runs
 * inside a caller-provided transaction; the caller checks authority (canManageSite) first.
 *
 * ── AND THE BILLING GATE (2026-08-06) ───────────────────────────────────────────────────────────
 * "No new job cards after grace" means NO NEW BOOKINGS, not no new rows. Taking a workshop slot is
 * what the subscription buys, so the gate lives HERE rather than on card creation: a card raised
 * from the quote entry point carries no resource and no start time, occupies nothing, and stays
 * allowed. That lets a restricted garage keep taking enquiries and quoting for them.
 *
 * Putting it here also settles an inconsistency that was already live: /api/jobcard-accept refused
 * a booking when lapsed while /api/diary — the drag path — did not, so the same act had two
 * answers. Four callers, one function, one rule.
 *
 * ── TWO ACTS, AND ONLY ONE OF THEM IS A MOVE (2026-10-01) ───────────────────────────────────────
 * Every caller now says which act it is performing, because two of the rules below apply to one
 * and not the other and the row cannot tell them apart:
 *
 *   'book'  the garage deciding when a car comes in. A card being reopened from `declined` and
 *           booked is this, and its stale slot data is exactly what the act replaces. An imported
 *           historical card is this too, and its start may legitimately sit outside today's hours.
 *   'move'  changing a decision already made — the diary's drag and its Reschedule dialog. This
 *           is the one that refuses a slot which has become a RECORD (lib/jobcard-status's
 *           SLOT_IS_HISTORY) and refuses a start that is not a working moment.
 *
 * A union rather than an optional flag: a new caller cannot arrive without deciding, and the
 * answer is at the call site where somebody is thinking about it.
 *
 * Throws: CARD_NOT_FOUND | RESOURCE_NOT_FOUND | CROSS_SITE | EMPTY_FOOTPRINT | CLASH:<reg>
 *       | BILLING_RESTRICTED | SLOT_IS_HISTORY:<status> | NOT_WORKING_TIME | SPAN_TOO_LONG
 */
import { Prisma } from '@prisma/client';
import { computeFootprint, footprintsClash, parseBreaks, isWorkingMoment } from '@/lib/occupancy';
import { FREES_THE_SLOT, canMoveBooking } from '@/lib/jobcard-status';
import { canBook, gateFromRow, BILLING_GATE_SELECT } from '@/lib/billing';

export type PlaceParams = {
  jobCardId: string;
  resourceId: string;
  start: Date;
  workingMinutes: number; // WORKING duration; the footprint + end_at are derived from it
  siteIds: string[];      // caller's visible sites
  /** Which act this is — see the header. Required: a caller that has not decided is a caller that
   *  does not know whether the two move-only rules apply to it. */
  act: 'book' | 'move';
};

/**
 * WHERE A BOOKING WAS, AND WHERE IT WENT. Returned by placeJobCard so an audit row and an undo can
 * be built from what was ACTUALLY read and written in the transaction, rather than from a second
 * read that may already have moved. `from` is all-null on a card that held no slot.
 */
export type Placement = { resourceId: string | null; startAt: string | null; workingMinutes: number | null };
export type PlacedResult = { from: Placement; to: Placement };

// Candidate prefilter lookback, and THE BOUND ON WHAT MAY BE WRITTEN. It used to be only the first,
// with a comment asking the reader to keep a form's duration cap below it — a premise about another
// file that nothing checked. Now placeJobCard refuses any booking whose footprint spans longer than
// this, so the window can never be smaller than the thing it is searching for. EXPORTED so the gate
// reads the bound rather than restating the number.
// Raising it is safe; LOWERING it narrows what the garage may book, which is a product decision.
export const PREFILTER_LOOKBACK_MS = 14 * 24 * 3600000;

export async function placeJobCard(tx: Prisma.TransactionClient, p: PlaceParams): Promise<PlacedResult> {
  const card = await tx.jobCard.findFirst({
    where: { id: p.jobCardId, site_id: { in: p.siteIds } },
    // status + the current slot: the refusal below needs the first, and the audit row and the undo
    // need the second. Read INSIDE the transaction, from the row being written.
    select: { id: true, site_id: true, group_id: true, status: true, resource_id: true, start_at: true, booking_duration_minutes: true, end_at: true },
  });
  if (!card) throw new Error('CARD_NOT_FOUND');

  // ── A FINISHED OR ABANDONED SLOT IS A RECORD, NOT A PLAN ────────────────────────────────────
  // Move-only: booking a reopened `declined` card is a legitimate 'book' and would be refused here
  // otherwise — the rule is about rewriting a decision, not about the status alone.
  if (p.act === 'move' && !canMoveBooking(card.status)) throw new Error(`SLOT_IS_HISTORY:${card.status}`);

  // MAY THIS TENANT TAKE A SLOT? Asked before any clash maths — a restricted tenant gets the same
  // answer whether or not the lift happens to be free, and the reason names billing rather than
  // availability.
  const billing = await tx.groupBilling.findUnique({ where: { group_id: card.group_id }, select: BILLING_GATE_SELECT });
  if (!canBook(gateFromRow(billing as any))) throw new Error('BILLING_RESTRICTED');

  const resource = await tx.resource.findFirst({ where: { id: p.resourceId, site_id: { in: p.siteIds } }, select: { id: true, site_id: true } });
  if (!resource) throw new Error('RESOURCE_NOT_FOUND');
  if (resource.site_id !== card.site_id) throw new Error('CROSS_SITE');

  // Site hours + open-days drive the footprint (skips whatever is actually closed — never hardcoded).
  const site = await tx.site.findUnique({ where: { id: card.site_id }, select: { open_hour: true, close_hour: true, open_days: true, breaks: true } });
  const openHour = site?.open_hour ?? 8;
  const closeHour = site?.close_hour ?? 18;
  const openDays = site?.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6];
  const breaks = parseBreaks(site?.breaks);

  // ── A DROP OUTSIDE WORKING TIME IS REFUSED, NEVER CORRECTED ─────────────────────────────────
  // computeFootprint advances a non-working start to the next working moment, which is right for
  // an end and silent relocation for a start: dropped at 20:00 the card would reappear at 08:00
  // tomorrow having been "moved" somewhere nobody chose. Move-only, because an imported card's
  // backdated start may legitimately sit outside the hours the site keeps today.
  if (p.act === 'move' && !isWorkingMoment(p.start.toISOString(), openHour, closeHour, openDays, breaks)) {
    throw new Error('NOT_WORKING_TIME');
  }

  const newFp = computeFootprint(p.start.toISOString(), p.workingMinutes, openHour, closeHour, openDays, breaks);
  if (newFp.segments.length === 0) throw new Error('EMPTY_FOOTPRINT');
  const newEnd = new Date(Date.parse(newFp.endISO));

  // ── NO BOOKING MAY SPAN MORE CALENDAR TIME THAN THE CLASH PREFILTER LOOKS BACK ──────────────
  // The prefilter below finds candidates by `start_at >= newStart − LOOKBACK`. A booking longer
  // than that window could be missed entirely: its start would sit outside the window while its
  // footprint reached into the new one, and the double-booking guard would pass on a real clash.
  //
  // The comment on PREFILTER_LOOKBACK_MS has always said "raise this if the duration cap ever
  // exceeds 5 working days" — a premise about a cap that lives in a FORM, which the server never
  // checked and a form cannot promise. Enforced here instead, against the constant it protects, so
  // the two cannot disagree: what is written can never exceed what is searched.
  if (newEnd.getTime() - p.start.getTime() > PREFILTER_LOOKBACK_MS) throw new Error('SPAN_TOO_LONG');

  // Superset prefilter (indexed on resource_id, start_at): any existing booking that could overlap
  // must START within [newStart - LOOKBACK, newFootprintEnd]. end_at is NOT trusted here — the exact
  // test is footprint-vs-footprint below, so a stale end_at can never cause a missed clash.
  const windowStart = new Date(p.start.getTime() - PREFILTER_LOOKBACK_MS);
  const candidates = await tx.jobCard.findMany({
    // A cancelled/declined card KEEPS its slot data (the record of when it had been booked) but must NOT
    // occupy the lift — same "off diary" definition the display reader uses, so guard and board agree.
    where: { id: { not: p.jobCardId }, resource_id: p.resourceId, status: { notIn: FREES_THE_SLOT }, start_at: { gte: windowStart, lte: newEnd } },
    select: { start_at: true, end_at: true, booking_duration_minutes: true, vehicle: { select: { registration: true } } },
  });
  for (const c of candidates) {
    if (!c.start_at) continue;
    // Transitional fallback: a pre-backfill row has NULL duration → recover it from (end_at - start_at),
    // which equals the working-minutes the old naive form implied.
    const mins = c.booking_duration_minutes ?? Math.round(((c.end_at?.getTime() ?? c.start_at.getTime()) - c.start_at.getTime()) / 60000);
    if (!(mins > 0)) continue;
    const fp = computeFootprint(c.start_at.toISOString(), mins, openHour, closeHour, openDays, breaks);
    if (footprintsClash(newFp, fp)) throw new Error(`CLASH:${c.vehicle?.registration ?? 'another job'}`);
  }

  await tx.jobCard.update({
    where: { id: p.jobCardId },
    data: { resource_id: p.resourceId, start_at: p.start, booking_duration_minutes: p.workingMinutes, end_at: newEnd },
  });

  return {
    from: {
      resourceId: card.resource_id ?? null,
      startAt: card.start_at ? card.start_at.toISOString() : null,
      // Same transitional fallback the clash scan uses: a pre-backfill row's duration is recovered
      // from (end_at - start_at), so an undo of such a card restores a real length and not a null.
      workingMinutes: card.booking_duration_minutes
        ?? (card.start_at && card.end_at ? Math.round((card.end_at.getTime() - card.start_at.getTime()) / 60000) : null),
    },
    to: { resourceId: p.resourceId, startAt: p.start.toISOString(), workingMinutes: p.workingMinutes },
  };
}
