/**
 * File: lib/due-items.ts
 * THE due-item rules: what a valid finding is, and the one read that surfaces open ones.
 *
 * ── WHAT A DUE ITEM IS FOR ──────────────────────────────────────────────────────────────────────
 * A Platinum service on FG73KWE needed two extra items. They were visible on the car at 09:30 and
 * reached the owner at lunchtime, after the upsell window closed. A due item is that finding,
 * written down where it will be found again — this year for the upsell, next year for the reminder.
 *
 * ── THE THREE-STATE RESPONSE IS THE COMMERCIAL POINT ────────────────────────────────────────────
 * `not_raised` (nobody asked) and `declined` (asked, said no) are different facts and only the
 * second is a lead. There is NO default on the column and none here: a capture surface that
 * pre-selects one would make `declined` vanishingly rare while looking like it was recording it —
 * the failure mode is silent, which is what makes it worth a refusal rather than a default.
 *
 * THE ONE EXCEPTION, AND WHY IT IS NOT A HOLE IN THIS RULE. lib/service-schedule defaults the
 * response to `not_raised`. The argument above is about a FINDING — something spotted with a
 * customer at the car, where "did you mention it?" has an answer and `declined` is the lead. A
 * schedule row is transcribed off a service computer ten months before that conversation happens:
 * there is no answer to give, and demanding six taps would produce six meaningless `not_raised`
 * records instead of one honest absence.
 *
 * Both halves are stated at both files ON PURPOSE. They look like the same rule contradicting
 * itself, and the next person to notice will want to harmonise them — which would either put a
 * pointless tap on a transcription form or let a default creep back onto findings, where it is the
 * silent failure described above.
 *
 * ── THE CUSTOMER IS NOT PART OF THE RECORD ──────────────────────────────────────────────────────
 * Resolved at reminder time through the ownership edge. Never stored, never joined here.
 */
import type { Prisma } from '@prisma/client';

export type DueBasis = 'date' | 'mileage' | 'next_service' | 'whichever_first';
export type DueItemResponse = 'not_raised' | 'declined' | 'agreed_later' | 'wants_call';

export type DueItemRefusal = { code: string; message: string };

export type DueItemInput = {
  description: string;
  dueBasis: DueBasis | null | undefined;
  dueDate?: Date | null;
  dueMileage?: number | null;
  customerResponse: DueItemResponse | null | undefined;
};

const BASES: readonly DueBasis[] = ['date', 'mileage', 'next_service', 'whichever_first'];
const RESPONSES: readonly DueItemResponse[] = ['not_raised', 'declined', 'agreed_later', 'wants_call'];

/**
 * May this finding be recorded? PURE, so every refusal is provable without writing a row.
 *
 * The two refusals that matter are both about a MISSING DECISION, not a missing value: a basis
 * nobody chose, and a response nobody chose. Everything else is shape.
 */
export function refuseDueItem(input: DueItemInput): DueItemRefusal | null {
  if (!input.description?.trim()) {
    return { code: 'no_description', message: 'Say what the car needs.' };
  }
  if (!input.dueBasis || !BASES.includes(input.dueBasis)) {
    // NOT inferred from which value is filled. Both a date and a mileage can be present ("by March
    // or 60k, whichever comes first") and only one binds; letting the data decide is the
    // demo_expires_at defect — one column quietly answering two questions.
    return { code: 'no_basis', message: 'Choose what makes this due: a date, a mileage, or the next service.' };
  }
  // PRECISION IS ABOUT RENDERING, NOT VALIDITY. A month-precision row is correctly
  // indistinguishable from a day one here: both carry a real instant, and "which day did they
  // mean" is a question for dueLabel, not for whether the row may exist. Nothing below should
  // learn about due_date_precision.
  if (input.dueBasis === 'date' && !(input.dueDate instanceof Date) ) {
    return { code: 'no_date', message: 'This is due by a date, so give the date.' };
  }
  if (input.dueBasis === 'mileage' && !(Number.isInteger(input.dueMileage) && (input.dueMileage as number) > 0)) {
    return { code: 'no_mileage', message: 'This is due by mileage, so give the mileage.' };
  }
  if (input.dueBasis === 'whichever_first') {
    // BOTH legs are required — that is what makes it "whichever". One leg alone is a different
    // basis and should be recorded as one, or the item silently loses the trigger that would
    // actually have fired first.
    if (!(input.dueDate instanceof Date)) {
      return { code: 'no_date', message: 'This is due by a date OR a mileage, so give the date as well.' };
    }
    if (!(Number.isInteger(input.dueMileage) && (input.dueMileage as number) > 0)) {
      return { code: 'no_mileage', message: 'This is due by a date OR a mileage, so give the mileage as well.' };
    }
  }
  if (!input.customerResponse || !RESPONSES.includes(input.customerResponse)) {
    // THE ONE THAT PROTECTS THE MARKETING LIST. No default anywhere in the stack: the person
    // recording the finding says which of the three happened, or nothing is recorded.
    return {
      code: 'no_response',
      message: 'Say whether the customer was told: not raised yet, they declined, or they want it later.',
    };
  }
  return null;
}

/**
 * `response_at` follows the response, and only an ANSWER is an event.
 * `not_raised` means nobody answered — that is an absence, not an answer at time-unknown, so the
 * column stays NULL and a reader can tell the two apart.
 */
export const responseAtFor = (r: DueItemResponse, now: Date): Date | null =>
  r === 'not_raised' ? null : now;

export type OpenDueItem = {
  id: string;
  description: string;
  dueBasis: DueBasis;
  dueDate: string | null;
  dueMileage: number | null;
  /** The countdown the target was derived from, when the garage read one off the cluster. NULL when
   *  they typed a target. See the schema note on VehicleDueItem.countdown_miles. */
  countdownMiles?: number | null;
  customerResponse: DueItemResponse;
  foundOnJobCardId: string | null;
  createdAt: string;
  /** Which tapped observation this is, or NULL when a human typed it. See lib/observation-keys. */
  observationKey?: string | null;
  /** The description already says WHEN — so no surface appends a second answer. */
  timingInDescription?: boolean;
  /** `month` = only the month and year were known; the stored 1st was never meant. Default `day`. */
  dueDatePrecision?: 'day' | 'month';
};

/**
 * OPEN items for a vehicle — THE surfacing read, shared by the job card and the booking lookup so
 * the two can never disagree about what a car still needs. Open = `closed_at IS NULL`; there is no
 * status column to drift out of step with the timestamp.
 */
export async function openDueItemsForVehicle(
  db: Prisma.TransactionClient | { vehicleDueItem: { findMany: (a: unknown) => Promise<unknown> } },
  groupId: string,
  vehicleId: string | null | undefined,
): Promise<OpenDueItem[]> {
  if (!vehicleId) return [];
  const rows = (await (db as { vehicleDueItem: { findMany: (a: unknown) => Promise<unknown> } }).vehicleDueItem.findMany({
    where: { group_id: groupId, vehicle_id: vehicleId, closed_at: null },
    orderBy: { created_at: 'desc' },
    select: {
      id: true, description: true, due_basis: true, due_date: true, due_mileage: true, countdown_miles: true,
      customer_response: true, found_on_job_card_id: true, created_at: true, observation_key: true,
      timing_in_description: true, due_date_precision: true,
    },
  })) as Array<{
    id: string; description: string; due_basis: DueBasis; due_date: Date | null; due_mileage: number | null;
    countdown_miles: number | null;
    customer_response: DueItemResponse; found_on_job_card_id: string | null; created_at: Date;
    observation_key: string | null; timing_in_description: boolean;
    due_date_precision: 'day' | 'month';
  }>;
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    dueBasis: r.due_basis,
    dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
    dueMileage: r.due_mileage,
    countdownMiles: r.countdown_miles,
    customerResponse: r.customer_response,
    foundOnJobCardId: r.found_on_job_card_id,
    createdAt: r.created_at.toISOString().slice(0, 10),
    // Carried so a tap-list can show an observation already recorded as done rather than offering
    // a tap that would be a no-op. NULL for a hand-typed finding, which is the whole point of it.
    observationKey: r.observation_key,
    timingInDescription: r.timing_in_description,
    dueDatePrecision: r.due_date_precision,
  }));
}

/**
 * WHETHER TO APPEND A TIMING AT ALL — one rule, and every surface asks it rather than deciding.
 *
 * A finding normally says WHAT and the basis says WHEN, and joining them is right. But some
 * descriptions carry their own timing, and appending a second answer produced this on a real
 * customer's invoice: "…a cell has failed. Replace. due at the next service". Two answers to one
 * question, the second one wrong about the car.
 *
 * The flag is AUTHORED where the description is written, never inferred from the string — deriving
 * meaning from description text is exactly the mistake observation_key exists to undo.
 */
export const showsDueLabel = (item: Pick<OpenDueItem, 'timingInDescription'>): boolean =>
  item.timingInDescription !== true;

/**
 * A stored ISO date, said the way a customer reads it.
 *
 * The MOT line in printedDueItemsBlock has always used this format; the basis label printed the raw
 * `2026-09-15` instead, so one block could carry both. It went unnoticed while no finding used a
 * `date` basis — and then a failed battery cell started getting a real date, which is a line that
 * will actually print. Fixed rather than shipped, because the exposure is mine.
 *
 * Parsed as UTC: these are calendar dates, not instants, and a local-time parse moves them a day
 * either side of midnight in the wrong direction depending on the season.
 */
/**
 * A month and year, for a date whose day was never known.
 *
 * "November 2026" is what a service computer said. "1 November 2026" is a day we invented to fit a
 * DateTime column, and printing it on an invoice a customer keeps would be the fabricated-constant
 * failure this codebase refuses everywhere else.
 */
// AND THE CONVERSE, so this is not read as a house style: where the day IS known — an MOT expiry,
// which DVSA states as a real date — the day is printed. See lib/mot-refresh, which prints
// "25 July 2027" for exactly that reason. The rule is "say what is known", not "prefer months".
function britishMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  if (!y || !m) return iso;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function britishDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso; // unparseable: show what we have rather than inventing a date
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * ── WHAT THIS FUNCTION CANNOT SAY, AND THE OPTION IF IT EVER MUST ───────────────────────────────
 * There is no output here for "this finding has no clock". A battery advised for replacement before
 * winter is not due at the next service, not due on a defensible date (a November deadline would be
 * a policy dressed as a measurement), and not due at a mileage — so it stores `next_service` and
 * `timing_in_description` keeps that off the customer's document. The untruth is still in the row,
 * where the surfacing read and effectiveDueDate can see it.
 *
 * THE STATED OPTION, if a third such finding appears: make `due_basis` NULLABLE — honest-null,
 * "this has no clock" — rather than adding a fifth enum value, which would only move the problem.
 * Every reader would then have to handle the absence, which is the point rather than the cost.
 *
 * NOT done speculatively: refuseDueItem deliberately requires a basis ("NOT inferred from which
 * value is filled"), and reversing a deliberate decision deserves its own report rather than a
 * quiet ride on somebody's slice. Recorded here so the next person finds the reasoning instead of
 * rediscovering the tension.
 *
 * One line of human text for a due item's timing — the same words on every surface.
 */
export function dueLabel(
  item: Pick<OpenDueItem, 'dueBasis' | 'dueDate' | 'dueMileage' | 'dueDatePrecision'>,
  /**
   * ── OVERDUE IS A FACT ABOUT THE MILEAGE LEG ONLY, AND ON PURPOSE ─────────────────────────────
   * The car's reading, when the caller has one. "Due at 68,120 miles" is true of a car sitting on
   * 68,360 and understates it badly: the customer's own dash says "Service overdue" and we should
   * be neither more alarming than the car nor softer than it.
   *
   * NOT DONE FOR THE DATE LEG, deliberately. At mint we know the departure odometer, so overdue-by
   * -mileage is a fact ABOUT THE VISIT and can be frozen onto a document honestly. Whether a DATE
   * has passed depends on when you read the paper, and an invoice's text is frozen — a document
   * that silently became "overdue" between printings would be making a claim nobody wrote. The
   * board answers the date question separately, where it is allowed to change.
   *
   * Omitted or null → the wording is exactly what it always was, for every caller that has no
   * reading to compare against.
   */
  atMiles?: number | null,
): string {
  const miles = item.dueMileage != null ? `${item.dueMileage.toLocaleString('en-GB')} miles` : 'a mileage';
  const past = atMiles != null && item.dueMileage != null && atMiles >= item.dueMileage;
  const by = past ? (atMiles as number) - (item.dueMileage as number) : 0;
  // EXACTLY ON THE TARGET IS DUE, NOT OVERDUE — and "overdue by 0 miles" is not a sentence.
  // effectiveDueDate treats `>=` as passed for ORDERING, which is right: a service due now belongs
  // at the top of the list. This is the WORDING, and it can be precise where the ordering only
  // needs a rank. The two agreeing on urgency while differing in words is the point.
  const exactly = past && by === 0;
  const overdueBy = `overdue by ${by.toLocaleString('en-GB')} miles — was `;
  // ONE PLACE DECIDES HOW A DUE DATE READS, so the invoice block, the customer report and the
  // marketing list cannot disagree — and none of them can print a day that was never known.
  const when = (iso: string) => (item.dueDatePrecision === 'month' ? britishMonth(iso) : britishDate(iso));
  switch (item.dueBasis) {
    case 'date': return item.dueDate ? `due by ${when(item.dueDate)}` : 'due by a date';
    case 'mileage':
      if (exactly) return `due now, at ${miles}`;
      return past ? `${overdueBy}due at ${miles}` : `due at ${miles}`;
    case 'next_service': return 'due at the next service';
    // The label needs NO RATE — it states both legs, exactly as the garage wrote it. Only ORDERING
    // needs a projection, and that is effectiveDueDate's job.
    case 'whichever_first': {
      const when2 = item.dueDate ? when(item.dueDate) : 'a date';
      // ── ONCE ONE LEG HAS FIRED, THE OTHER IS NOT THEREBY IN THE PAST ─────────────────────────
      // This used to read `was due at 68,120 miles or by October 2027, whichever came first`, and
      // the reasoning was sound as far as it went: `was due …` beside `whichever comes first` is a
      // sentence arguing with itself. Backdating BOTH legs bought that agreement with a claim the
      // function is in no position to make.
      //
      // It has no clock. `atMiles` is the only comparison input, deliberately — see the note on the
      // parameter — so a passed MILEAGE leg is knowable and a passed DATE leg is not. Saying the
      // date "came first" asserts it has been and gone. On TMBS that printed "was due at 1,000
      // miles or by July 2027" against a car that had never been near either figure: a date eleven
      // months away, in the past tense, on a customer's document.
      //
      // So the either/or closes when it is answered. The leg that fired takes the past tense; the
      // other is stated as a fact of the SCHEDULE — "also set for October 2027" — which is true
      // whether or not that date has passed. Present-tense "whichever comes first" would be the
      // same error mirrored: re-opening a question the mileage has already settled.
      if (exactly) return `due now, at ${miles}, also set for ${when2}`;
      return past
        ? `${overdueBy}due at ${miles}, also set for ${when2}`
        // STILL A QUESTION, so both legs stay open and the wording is untouched. Four gates pin
        // this string; it is the state the change is careful NOT to reach.
        : `due at ${miles} or by ${when2}, whichever comes first`;
    }
  }
}

// ── ORDERING: WHEN IS THIS ACTUALLY DUE? ─────────────────────────────────────────────────────────
export type DueProjection =
  | { ok: true; date: Date; binding: 'date' | 'mileage'; mileageLegUnevaluated?: boolean;
      /** The mileage target is already behind this car — the date is "now", not a projection. */
      alreadyPassed?: boolean }
  | { ok: false; reason: 'next_service' | 'no_rate' | 'no_date' };

/**
 * The date an item should surface on, or a STATED reason there isn't one.
 *
 * `whichever_first` is the interesting case and the reason this function exists. With a rate, the
 * earlier of (the date, the projected mileage date) binds — which is the whole meaning of the
 * phrase. WITHOUT a rate the mileage leg cannot be evaluated, and the honest answer is not "no
 * date": the written date still BOUNDS it, so it is returned with `mileageLegUnevaluated` set. A
 * caller can then remind at the date (late if the mileage would have come first) while knowing the
 * figure is a ceiling rather than the answer — which is better than surfacing nothing at all.
 */
export function effectiveDueDate(
  item: { dueBasis: DueBasis; dueDate: Date | null; dueMileage: number | null },
  ctx: {
    currentMiles: number | null;
    project: (targetMiles: number) => Date | null;
    /** Passed in rather than read from the clock, so an already-passed target is testable at a
     *  fixed date. Optional for the callers that never meet one. */
    now?: Date;
  },
): DueProjection {
  switch (item.dueBasis) {
    case 'next_service':
      // Tied to a visit, not a clock. Not a failure — a different kind of trigger.
      return { ok: false, reason: 'next_service' };
    case 'date':
      return item.dueDate ? { ok: true, date: item.dueDate, binding: 'date' } : { ok: false, reason: 'no_date' };
    case 'mileage': {
      if (item.dueMileage == null) return { ok: false, reason: 'no_date' };
      // ── ALREADY PAST THE TARGET IS AN ANSWER, NOT A FAILURE ───────────────────────────────
      // projectMileageDate returns null once `remaining <= 0`, and reading every null as `no_rate`
      // said "we cannot work out when this is due" about a car whose trigger had ALREADY FIRED.
      // Those are opposites. A caller asking "when is this due" gets today, which is true and needs
      // no translation from a failure code into a fact.
      if (ctx.currentMiles != null && ctx.currentMiles >= item.dueMileage) {
        return { ok: true, date: ctx.now ?? new Date(), binding: 'mileage', alreadyPassed: true };
      }
      const p = ctx.project(item.dueMileage);
      return p ? { ok: true, date: p, binding: 'mileage' } : { ok: false, reason: 'no_rate' };
    }
    case 'whichever_first': {
      if (!item.dueDate || item.dueMileage == null) return { ok: false, reason: 'no_date' };
      // The mileage leg has already fired, so it is the earlier of the two whatever the date says.
      if (ctx.currentMiles != null && ctx.currentMiles >= item.dueMileage) {
        return { ok: true, date: ctx.now ?? new Date(), binding: 'mileage', alreadyPassed: true };
      }
      const p = ctx.project(item.dueMileage);
      if (!p) return { ok: true, date: item.dueDate, binding: 'date', mileageLegUnevaluated: true };
      return p.getTime() < item.dueDate.getTime()
        ? { ok: true, date: p, binding: 'mileage' }
        : { ok: true, date: item.dueDate, binding: 'date' };
    }
  }
}

// ── THE PRINTED BLOCK ────────────────────────────────────────────────────────────────────────────
/**
 * The lines that go on the invoice — and, frozen, into Invoice.due_items_snapshot at mint.
 *
 * ── WHY THE MOT EXPIRY IS IN HERE ───────────────────────────────────────────────────────────────
 * Because the garage prints it, and because it is the one line nobody should have to type: it is
 * DVSA-sourced on the vehicle. It leads the block, as it does on the real invoices this replaces.
 *
 * ── AND WHY IT MUST BE FROZEN WITH THE REST ─────────────────────────────────────────────────────
 * The MOT expiry MOVES the moment the car is retested. Rendering it live would print next year's
 * date against last year's invoice — quieter than a changing findings list and just as wrong. A
 * customer holding June's invoice must be able to hold it up against a reprint and see the same
 * page.
 *
 * Numbered, one per line, exactly as a garage writes them by hand.
 */
/**
 * ── THREE CATEGORIES, THREE HEADINGS ────────────────────────────────────────────────────────────
 * This was ONE block under "Advisory — not charged for", and it mixed three different kinds of
 * statement. On a real invoice it read:
 *
 *   (1) MOT Expiry 29 August 2027                        ← a fact from DVSA
 *   (2) Battery — 62% health…, worth watching            ← an advisory
 *   (3) Wiper blades smearing                            ← an advisory
 *   (6) Front left — 6.0 / 6.0 / 6.0mm                   ← a measurement
 *  (10) Battery — 12.48V, 76% charge, 62% health         ← the same battery, measured
 *
 * The heading described lines 2 and 3 and misdescribed the other eight. A tread depth is not an
 * advisory and neither is an MOT date, and the battery appeared twice — once as a judgement and
 * once as the evidence for it, which read as the same claim made twice.
 *
 * So: WHAT YOUR CAR NEEDS (the MOT date at its head, because it IS something the car needs) and
 * WHAT WE MEASURED. "Sorted on this visit" is the third, built in lib/due-item-closure.
 *
 * Numbered independently. A customer reads two short lists, not one long one with a gear change
 * in the middle.
 */
export function printedNeedsBlock(args: {
  motExpiry: Date | null;
  /** The car's reading, so a target it has already passed does not print as still ahead of it.
   *  NULL when unknown — the wording then stays exactly as it was. */
  atMiles?: number | null;
  items: Array<Pick<OpenDueItem, 'description' | 'dueBasis' | 'dueDate' | 'dueMileage' | 'timingInDescription' | 'dueDatePrecision'>>;
}): string | null {
  const lines: string[] = [];
  if (args.motExpiry) {
    lines.push(`MOT Expiry ${args.motExpiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`);
  }
  for (const it of args.items) lines.push(showsDueLabel(it) ? `${it.description} ${dueLabel(it, args.atMiles)}` : it.description);
  if (!lines.length) return null;
  return lines.map((l, i) => `(${i + 1}) ${l}`).join('\n');
}

/**
 * WHAT WE MEASURED — the readings, as evidence a customer can check.
 *
 * Tyres as TEXT, deliberately: a four-corner table would print prettier and freeze worse, and the
 * invoice is a document whose job is to reprint identically.
 *
 * NULL, not an empty string: nothing measured is not the same as a block that printed empty, and a
 * reader of the column can tell them apart.
 */
export function printedMeasuredBlock(args: {
  tyreLines?: string[];
  batteryLine?: string | null;
}): string | null {
  const lines = [...(args.tyreLines ?? [])];
  if (args.batteryLine) lines.push(args.batteryLine);
  if (!lines.length) return null;
  return lines.map((l, i) => `(${i + 1}) ${l}`).join('\n');
}

/**
 * ── THE OLD COMBINED BLOCK, KEPT FOR DOCUMENTS THAT WERE MINTED WITH IT ─────────────────────────
 * Freeze-at-issue governs CONTENT: an invoice issued before 21 August 2026 says what it said, and
 * its due_items_snapshot holds all three categories in one list. This is how that text was built,
 * retained so the shape is legible to whoever finds one — NOT called by any live path.
 *
 * Renderers tell the two apart by measured_snapshot being NULL, which is what "minted before the
 * split" looks like in the data. Do not backfill it: the old documents are correct as they stand.
 */
export function printedDueItemsBlock(args: {
  motExpiry: Date | null;
  /** The car's reading, so a target it has already passed does not print as still ahead of it.
   *  NULL when unknown — the wording then stays exactly as it was. */
  atMiles?: number | null;
  items: Array<Pick<OpenDueItem, 'description' | 'dueBasis' | 'dueDate' | 'dueMileage' | 'timingInDescription' | 'dueDatePrecision'>>;
  tyreLines?: string[];
  batteryLine?: string | null;
}): string | null {
  const lines: string[] = [];
  if (args.motExpiry) {
    lines.push(`MOT Expiry ${args.motExpiry.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`);
  }
  for (const it of args.items) lines.push(showsDueLabel(it) ? `${it.description} ${dueLabel(it, args.atMiles)}` : it.description);
  for (const t of args.tyreLines ?? []) lines.push(t);
  if (args.batteryLine) lines.push(args.batteryLine);
  if (!lines.length) return null;
  return lines.map((l, i) => `(${i + 1}) ${l}`).join('\n');
}

// ── THE CUSTOMER'S OWN ANSWER ────────────────────────────────────────────────────────────────────
export type CustomerAnswer = 'yes' | 'no' | 'call_me';

/**
 * How a customer's tap lands on the GARAGE's field.
 *
 * "Yes" is INTEREST, NOT ACCEPTANCE — the report carries no prices, so a yes means "quote me for
 * this", and the estimate still goes out and comes back through acceptQuote like any other. That is
 * why yes maps to `agreed_later` and never to anything that reads as agreement to a figure.
 */
/**
 * ── AN ANSWER CAN BE CORRECTED; IT CANNOT BE UNASKED ───────────────────────────────────────────
 * Answers change — "they tapped no, then rang and changed their mind" is the normal shape, and
 * AnswerDivergence exists to show exactly that. So a garage may move a finding between the three
 * real answers as often as the customer changes their mind.
 *
 * `not_raised` is not one of them. It is the only value that leaves `response_at` null, and it
 * means "nobody has put this to the customer" — which stops being true the moment somebody does.
 * Allowing a revert would let a mis-tap erase the fact that the conversation happened, and the
 * board would count the car as an unanswered lead again. Record a different answer instead.
 */
export type ResponseRefusal = { code: 'bad_response'; message: string };
const REAL_ANSWERS: readonly DueItemResponse[] = ['declined', 'agreed_later', 'wants_call'];

export function refuseResponse(response: DueItemResponse | undefined | null): ResponseRefusal | null {
  if (!response || !REAL_ANSWERS.includes(response)) {
    return {
      code: 'bad_response',
      message: response === 'not_raised'
        ? 'A finding cannot go back to "not raised" — somebody has already asked. Record what they said instead.'
        : 'Say what the customer said: declined, agreed for later, or wants a call.',
    };
  }
  return null;
}

export const GARAGE_VIEW_OF: Record<CustomerAnswer, 'declined' | 'agreed_later' | 'wants_call'> = {
  yes: 'agreed_later',
  no: 'declined',
  call_me: 'wants_call',
};

export type AnswerDivergence = {
  /** What the customer themselves last tapped. */
  customer: CustomerAnswer;
  customerAt: string;
  /** What the garage will act on — may be newer, set by someone who took a phone call. */
  garage: DueItemResponse;
  /** True when the garage has since recorded something the customer did not say. */
  diverged: boolean;
};

/**
 * Do the two records disagree, and how?
 *
 * PURE, and deliberately NOT an error: a divergence is the normal shape of "they tapped no, then
 * rang and changed their mind". It exists to be SHOWN — inline beside the field when someone is
 * about to override, and permanently on the finding afterwards — never to fire an alert. The person
 * who creates a divergence is the person doing it deliberately, and notifying them about their own
 * action is the noise that stops escalations being read.
 */
export function answerDivergence(
  latest: { answer: CustomerAnswer; answeredAt: Date } | null,
  garage: DueItemResponse,
): AnswerDivergence | null {
  if (!latest) return null;
  return {
    customer: latest.answer,
    customerAt: latest.answeredAt.toISOString(),
    garage,
    diverged: GARAGE_VIEW_OF[latest.answer] !== garage,
  };
}

/**
 * RECORD A CUSTOMER'S ANSWER — the one writer, so the two records can never be written apart.
 *
 * Two writes, one transaction:
 *   1. APPEND to DueItemCustomerAnswer. Never updated: a customer who changes their mind on the
 *      same report leaves two rows in order, and the history of what they actually tapped survives.
 *   2. WRITE THROUGH to the garage's field, because the office needs one field to read. A later
 *      staff edit overrides it — last write wins on the garage side only.
 *
 * `response_at` is stamped here for the same reason it is stamped anywhere: an ANSWER is an event.
 * (`not_raised` is the only value that leaves it null, and a customer answer can never produce it.)
 */
export async function recordCustomerAnswer(
  tx: Prisma.TransactionClient,
  args: { groupId: string; dueItemId: string; answer: CustomerAnswer; magicLinkId: string | null; at: Date },
): Promise<{ garageResponse: DueItemResponse }> {
  const garageResponse = GARAGE_VIEW_OF[args.answer];
  await (tx as Prisma.TransactionClient).dueItemCustomerAnswer.create({
    data: {
      group_id: args.groupId,
      due_item_id: args.dueItemId,
      answer: args.answer,
      answered_at: args.at,
      magic_link_id: args.magicLinkId,
    },
  });
  await (tx as Prisma.TransactionClient).vehicleDueItem.update({
    where: { id: args.dueItemId },
    data: { customer_response: garageResponse, response_at: args.at },
  });
  return { garageResponse };
}

/** The customer's LATEST tap per finding — what the divergence check and the screens read. */
export async function latestCustomerAnswers(
  db: Prisma.TransactionClient | { dueItemCustomerAnswer: { findMany: (a: unknown) => Promise<unknown> } },
  dueItemIds: string[],
): Promise<Map<string, { answer: CustomerAnswer; answeredAt: Date }>> {
  if (!dueItemIds.length) return new Map();
  const rows = (await (db as { dueItemCustomerAnswer: { findMany: (a: unknown) => Promise<unknown> } }).dueItemCustomerAnswer.findMany({
    where: { due_item_id: { in: dueItemIds } },
    orderBy: { answered_at: 'asc' },   // ascending, so the last write into the map is the newest
    select: { due_item_id: true, answer: true, answered_at: true },
  })) as Array<{ due_item_id: string; answer: CustomerAnswer; answered_at: Date }>;
  const out = new Map<string, { answer: CustomerAnswer; answeredAt: Date }>();
  for (const r of rows) out.set(r.due_item_id, { answer: r.answer, answeredAt: r.answered_at });
  return out;
}

// ── "AWAITING RESPONSE" — DERIVED, NEVER AN EVENT ────────────────────────────────────────────────
export type ReportStatus =
  | { state: 'not_sent' }
  | { state: 'awaiting'; sentAt: string; days: number; answered: number; total: number }
  | { state: 'partial'; sentAt: string; days: number; answered: number; total: number }
  | { state: 'all_answered'; sentAt: string; answered: number };

/**
 * Where a card's intake report stands.
 *
 * NO RESPONSE IS NOT AN EVENT. Nothing happened, so nothing can fire — building it as a
 * notification would mean inventing an event from an absence and then deciding how often to nag.
 * It is derived from two facts the system already holds: when a report link was last minted, and
 * how many findings carry a customer answer. A card shows "sent 3 days ago, no reply" without any
 * scheduled job, and the figure cannot drift because nothing stores it.
 */
export function reportStatus(args: {
  lastSentAt: Date | null;
  totalFindings: number;
  answeredFindings: number;
  now: Date;
}): ReportStatus {
  if (!args.lastSentAt) return { state: 'not_sent' };
  const sentAt = args.lastSentAt.toISOString();
  const days = Math.floor((args.now.getTime() - args.lastSentAt.getTime()) / 86_400_000);
  if (args.totalFindings > 0 && args.answeredFindings >= args.totalFindings) {
    return { state: 'all_answered', sentAt, answered: args.answeredFindings };
  }
  const shape = args.answeredFindings > 0 ? 'partial' : 'awaiting';
  return { state: shape, sentAt, days, answered: args.answeredFindings, total: args.totalFindings };
}

// ── CLOSURE: DERIVED AND OFFERED, NEVER AUTOMATIC ────────────────────────────────────────────────
export type ClosureOffer =
  | { offer: false; reason: 'no_lines' | 'work_outstanding' }
  | { offer: true; invoicedLines: number };

/**
 * Should the card OFFER to close this finding?
 *
 * ── THE CASE THIS EXISTS FOR ────────────────────────────────────────────────────────────────────
 * A customer says yes to discs and pads. The garage fits the discs today and the pads next month.
 * One invoice is issued, one finding is genuinely finished, one is not. A rule that closed findings
 * on invoice would clear both — silently, and in the direction that loses agreed work.
 *
 * So: every linked line must sit on an ISSUED invoice before the offer appears, and even then it is
 * an OFFER. A person confirms. The prompt does the remembering; the judgement stays human.
 *
 * PURE, so the rule is provable without issuing anything.
 */
export function closureOffer(lines: Array<{ invoiceIssued: boolean }>): ClosureOffer {
  if (!lines.length) return { offer: false, reason: 'no_lines' };
  const invoiced = lines.filter((l) => l.invoiceIssued).length;
  // PARTIAL IS NOT DONE. This single comparison is the discs-and-pads case.
  if (invoiced < lines.length) return { offer: false, reason: 'work_outstanding' };
  return { offer: true, invoicedLines: invoiced };
}

/** Findings on a card with their linked lines' invoice state — the closure prompt's input. */
export async function closureOffersForCard(
  db: Prisma.TransactionClient | { dueItemLine: { findMany: (a: unknown) => Promise<unknown> } },
  groupId: string,
  dueItemIds: string[],
): Promise<Map<string, ClosureOffer>> {
  const out = new Map<string, ClosureOffer>();
  if (!dueItemIds.length) return out;
  const rows = (await (db as { dueItemLine: { findMany: (a: unknown) => Promise<unknown> } }).dueItemLine.findMany({
    where: { group_id: groupId, due_item_id: { in: dueItemIds } },
    select: { due_item_id: true, job_card_item: { select: { job_card: { select: { invoice: { select: { issued_at: true } } } } } } },
  })) as Array<{ due_item_id: string; job_card_item: { job_card: { invoice: { issued_at: Date | null } | null } } }>;
  const byItem = new Map<string, Array<{ invoiceIssued: boolean }>>();
  for (const r of rows) {
    const issued = !!r.job_card_item?.job_card?.invoice?.issued_at;
    byItem.set(r.due_item_id, [...(byItem.get(r.due_item_id) ?? []), { invoiceIssued: issued }]);
  }
  for (const id of dueItemIds) out.set(id, closureOffer(byItem.get(id) ?? []));
  return out;
}
