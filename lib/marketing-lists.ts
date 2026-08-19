/**
 * File: lib/marketing-lists.ts
 * WHICH CARS ARE DUE, WHAT IT IS WORTH, AND WHO TO RING.
 *
 * The whole intake feature has been feeding a marketing list that nothing read. This reads it.
 * Nothing here sends: the garage rings, texts or emails through the surfaces that already exist.
 *
 * ── AN OPT-OUT IS AN OPT-OUT OF EVERYTHING ──────────────────────────────────────────────────────
 * A customer who has opted out of a channel gets NO message on it — service or offer, no
 * adjudicating which is which. Every product that starts deciding that its own messages are
 * "service" ends up sending marketing labelled as service, and the customer who set the preference
 * is the one who finds out.
 *
 * THE COST, STATED SO IT IS A DECISION AND NOT AN OVERSIGHT: a customer who opts out of email after
 * one offer will not be emailed when their MOT expires. They will be on this list, with their
 * phone number, because a phone call is not an electronic message — but nothing will reach them
 * automatically, and their MOT may lapse. That is the price of not adjudicating, and it is worth
 * paying, because the alternative is a rule only we understand.
 *
 * ── PER CHANNEL, THOUGH ─────────────────────────────────────────────────────────────────────────
 * The ruling above is about the KIND of message, not the route. `sms_opt_out` and `email_opt_out`
 * are separate columns and a customer who refused texts and never mentioned email has not asked to
 * be silenced — collapsing them would take a decision they did not make. So a row says what is
 * actually available, and the phone number is always shown.
 */
import { effectiveDueDate, type OpenDueItem } from '@/lib/due-items';
import { mileageRate, projectMileageDate, type OdometerReading } from '@/lib/odometer';

/** The window both tabs answer. A month is what a garage plans; longer is a report nobody reads. */
export const WINDOW_DAYS = 30;
/** A snooze with no end is a hide. */
export const SNOOZE_DAYS = 30;

export type ContactRoute = { sms: boolean; email: boolean; phone: string | null };

/**
 * What can actually reach this customer. NULL opt-out means UNKNOWN, and unknown is treated as
 * allowed — the honest-null rule the comms spine already uses: we refuse on a recorded `true`, not
 * on the absence of a preference.
 */
export function contactRoute(c: {
  sms_opt_out: boolean | null; email_opt_out: boolean | null;
  phone: string | null; phone_e164: string | null; email: string | null;
}): ContactRoute {
  return {
    sms: c.sms_opt_out !== true && !!c.phone_e164,
    email: c.email_opt_out !== true && !!c.email,
    // The raw number, as the garage typed it and recognises it. Shown whatever the opt-outs say.
    phone: c.phone ?? null,
  };
}

/** How a row is labelled when something is refused. NULL when nothing is. */
export function noContactLabel(c: { sms_opt_out: boolean | null; email_opt_out: boolean | null }): string | null {
  const noSms = c.sms_opt_out === true, noEmail = c.email_opt_out === true;
  if (noSms && noEmail) return 'No electronic contact';
  if (noSms) return 'No texts';
  if (noEmail) return 'No email';
  return null;
}

// ── THE MOT TAB ──────────────────────────────────────────────────────────────────────────────────

export type MotBand = 'expired' | 'due';

/**
 * Which band an MOT date falls in, or null for a car that is neither.
 *
 * EXPIRED IS ITS OWN BAND, not "very due". A lapsed MOT is a better call than one three weeks away
 * — the car is off the road — and folding it into a single sorted list buries the urgent behind the
 * merely imminent.
 */
export function motBand(expiry: Date | null, now: Date, windowDays = WINDOW_DAYS): MotBand | null {
  if (!expiry) return null;
  const end = new Date(now.getTime() + windowDays * 86_400_000);
  if (expiry < now) return 'expired';
  return expiry <= end ? 'due' : null;
}

// ── THE SERVICING TAB ────────────────────────────────────────────────────────────────────────────

export type ServiceBand = 'dated' | 'trigger';

export type ServiceDue = {
  item: OpenDueItem;
  band: ServiceBand;
  /** The projected date, for the `dated` band. NULL on the trigger band. */
  date: Date | null;
  /** The words to show when there is no date — the item's own written trigger. */
  triggerText: string | null;
  /** True when a whichever_first item is showing on its date leg because no rate exists. */
  mileageLegUnevaluated: boolean;
};

/**
 * TWO BANDS, AND THE SECOND IS NOT A FAILURE BIN.
 *
 *   dated    — a projected date inside the window. Sorted by it.
 *   trigger  — `next_service`, or a mileage with no rate to project it. Shown with its OWN written
 *              trigger and no invented date.
 *
 * The trigger band is arguably the better call list: "due at the next service" means the car is
 * overdue a visit by definition. Hiding those would remove the cars most worth ringing, and giving
 * them a fabricated date would be worse — a projected reminder built on an invented rate looks like
 * a decision somebody made.
 *
 * A `whichever_first` item with no rate lands in `dated` on its DATE leg, flagged, which is exactly
 * what effectiveDueDate already does. No new rule; this only names the bands.
 */
export function serviceDue(
  items: OpenDueItem[],
  ctx: { now: Date; currentMiles: number | null; readings: OdometerReading[]; windowDays?: number },
): ServiceDue[] {
  const rate = mileageRate(ctx.readings);
  const project = (targetMiles: number): Date | null =>
    rate.ok && ctx.currentMiles != null
      ? projectMileageDate(ctx.currentMiles, targetMiles, rate, ctx.now)
      : null;
  const end = new Date(ctx.now.getTime() + (ctx.windowDays ?? WINDOW_DAYS) * 86_400_000);

  const out: ServiceDue[] = [];
  for (const item of items) {
    // ── ALREADY PAST THE TARGET IS OVERDUE, NOT UNPROJECTABLE ────────────────────────────────
    // projectMileageDate returns null when `remaining <= 0`, and effectiveDueDate turns any null
    // projection into `no_rate`. So a car that has already driven past "due at 60,000 miles" is
    // reported as having no clock, when in fact its clock has already gone off. Caught here rather
    // than in the shared chokepoint because effectiveDueDate also orders findings on the job card
    // and the invoice, and changing what it returns is a wider question than this list — raised
    // separately. The distinction matters most here, where an overdue car is the best call on the
    // page and the trigger band would bury it.
    const passed = item.dueMileage != null && ctx.currentMiles != null && ctx.currentMiles >= item.dueMileage;
    if (passed && (item.dueBasis === 'mileage' || item.dueBasis === 'whichever_first')) {
      out.push({ item, band: 'dated', date: ctx.now, triggerText: null, mileageLegUnevaluated: false });
      continue;
    }
    const p = effectiveDueDate(
      { dueBasis: item.dueBasis, dueDate: item.dueDate ? new Date(item.dueDate) : null, dueMileage: item.dueMileage },
      { currentMiles: ctx.currentMiles, project },
    );
    if (p.ok) {
      // Overdue counts as due: a service nobody booked last month is still work to win.
      if (p.date <= end) {
        out.push({ item, band: 'dated', date: p.date, triggerText: null, mileageLegUnevaluated: !!p.mileageLegUnevaluated });
      }
      continue;
    }
    // `next_service` and `no_rate` both mean "no clock we can read", which is a trigger, not a gap.
    if (p.reason === 'next_service' || p.reason === 'no_rate') {
      out.push({ item, band: 'trigger', date: null, triggerText: null, mileageLegUnevaluated: false });
    }
    // `no_date` is a malformed row and is deliberately NOT surfaced: it has nothing to tell anyone.
  }
  return out;
}

// ── THE BADGE ────────────────────────────────────────────────────────────────────────────────────

export type ContactRecord = {
  reason: 'mot' | 'service';
  forDate: Date;
  snoozeUntil: Date | null;
  /** When the contact was made. Needed for an ALREADY-OVERDUE trigger — see spentAt. */
  createdAt: Date;
};

/**
 * WHEN A CONTACT STOPS COUNTING.
 *
 * The first version spent it at `forDate` alone, which works for a trigger in the future and is
 * useless for one in the past: an EXPIRED MOT's date has already gone, so the record was spent the
 * instant it was written and the badge never fell. The gate caught it because the fixture was an
 * expired car — the band that matters most on that tab.
 *
 * Two branches, each defensible on its own:
 *   FUTURE trigger  — spend at the trigger. Contacted about an MOT due Monday and it is still not
 *                     done on Tuesday? That is a fresh conversation.
 *   PAST trigger    — spend a window later. The car was already overdue when they rang; there is no
 *                     date left to outlive, so the honest interval is "ask again next month".
 */
export function spentAt(record: Pick<ContactRecord, 'forDate' | 'createdAt'>, windowDays = WINDOW_DAYS): Date {
  return record.forDate > record.createdAt
    ? record.forDate
    : new Date(record.createdAt.getTime() + windowDays * 86_400_000);
}

/**
 * IS THIS CAR STILL WAITING FOR SOMEBODY TO DO SOMETHING?
 *
 * The badge counts these, NOT the size of the list — a count that never falls is one a garage stops
 * seeing within a week, and AdminLayout already carries the other half of that lesson ("a badge
 * showing 0 is noise pretending to be information"). This number drops as the list is worked and
 * comes back as the next car enters the window, which is the only shape that survives contact with
 * a real week.
 *
 * A CONTACT IS SPENT WHEN THE THING IT WAS ABOUT HAS PASSED. Contacted about an MOT due 1 September
 * and the car is still due on the 2nd? It needs contacting again. And if the MOT was actually done,
 * the new expiry is a year out and the car is not on the list at all — so one comparison covers
 * both, and it self-corrects rather than needing a sweep.
 */
export function isUnactioned(current: { dueDate: Date | null }, record: ContactRecord | null, now: Date): boolean {
  if (!record) return true;
  if (record.snoozeUntil && record.snoozeUntil > now) return false;
  if (record.snoozeUntil && record.snoozeUntil <= now) return true;
  // Spent — see spentAt for why this is not simply the trigger date.
  if (spentAt(record) <= now) return true;
  // A car on the trigger band has no date; a contact about it stands until it is snoozed or the
  // item is closed, because there is no date for it to outlive.
  if (!current.dueDate) return false;
  // The trigger moved out beyond what was contacted about — a renewal, so this is a new cycle.
  return current.dueDate > record.forDate;
}

// ── THE REVENUE TILE ─────────────────────────────────────────────────────────────────────────────

export type RevenueEstimate =
  | { ok: true; pennies: number; cars: number; averagePennies: number; basis: string }
  | { ok: false; reason: 'no_history' | 'no_price' };

/**
 * WHAT THE LIST IS WORTH — a rule of thumb, labelled as one.
 *
 * ── WHY IT IS NOT DERIVED FROM THE WORK ITSELF ──────────────────────────────────────────────────
 * Nothing prices a due item. `VehicleDueItem.service_catalogue_id` is nullable and has never been
 * written; `DueItemLine` — which would link a finding to what was actually charged for it — has no
 * rows at all. So the only honest figures available are the garage's OWN average invoice and,
 * eventually, its own history for that specific work.
 *
 * This is (c) of three: count × this tenant's average invoice, ex-VAT, over the last twelve months.
 * It is a rule of thumb and the label says so IN THE SAME BREATH as the number rather than
 * underneath it — "23 cars × your average job of £178" is readable; "£4,100 of work due" is a
 * forecast nobody made. When DueItemLine has data, the per-item history replaces this and the
 * label changes with it.
 *
 * EX-VAT, because VAT was never the garage's money.
 */
export function estimateRevenue(cars: number, averagePennies: number | null): RevenueEstimate {
  if (averagePennies == null || averagePennies <= 0) return { ok: false, reason: 'no_history' };
  return {
    ok: true,
    pennies: cars * averagePennies,
    cars,
    averagePennies,
    basis: 'average_invoice',
  };
}

/**
 * The MOT tab gets a figure ONLY if the garage sells MOTs at a known price.
 *
 * An average-invoice estimate is wrong here in a way it is not on the servicing tab: an MOT is a
 * fixed-price product, not an average job, and multiplying it by £178 would overstate the list by
 * a factor of three. So with no catalogue price there is NO NUMBER — and the tab says why, because
 * a missing tile reads as a bug and a sentence reads as a thing you can fix.
 */
export function estimateMotRevenue(cars: number, motPricePennies: number | null): RevenueEstimate {
  if (motPricePennies == null || motPricePennies <= 0) return { ok: false, reason: 'no_price' };
  return { ok: true, pennies: cars * motPricePennies, cars, averagePennies: motPricePennies, basis: 'mot_price' };
}
