/**
 * File: lib/service-schedule.ts
 * THE SERVICE SCHEDULE — the fourth capture shape, and the one that feeds the marketing list.
 *
 * Observations are NOTICED. Tyres and battery are MEASURED. These are TRANSCRIBED: read off the
 * service computer at a desk, each with a date, a mileage, or both, exactly as a garage's own
 * proforma recorded them.
 *
 * ── IT NEEDS NO NEW MODEL ───────────────────────────────────────────────────────────────────────
 * "Next oil service due at 60,000 miles or March 2027" is a thing the car needs with a clock on it,
 * which is a VehicleDueItem and a DueBasis — including `whichever_first`, which already demands
 * both legs and already refuses one. It inherits the customer report, the frozen invoice block and
 * the surfacing read for nothing, exactly as the tapped observations did.
 *
 * The partial unique index gives the right semantics free: one open "next oil service" per car, so
 * recording it again next visit UPDATES rather than stacks. A schedule is a current state, not a log.
 *
 * ── IT IS NOT PER-SITE SWITCHABLE, DELIBERATELY ─────────────────────────────────────────────────
 * The intake prompts have switches because an escalation must never name an item nobody was asked
 * for. This form has no escalation, so it has nothing to protect — and a sixth checkbox on a screen
 * no tenant had visited, gating a feature with no false positives to avoid, is how something ships
 * and stays invisible. It appears for everyone; a garage that does not transcribe leaves it empty.
 *
 * ── THE MOT IS READ-ONLY AND WRITES NOTHING ─────────────────────────────────────────────────────
 * Vehicle.mot_expiry already comes from DVSA and printedDueItemsBlock already prints it as the
 * FIRST line of every advisory block. A schedule row for it would print the MOT twice on every
 * invoice. So the form shows it, pre-filled, as confirmation that we already have it — and stores
 * nothing. See MOT_IS_READ_ONLY below, which exists so the next person finds the reasoning.
 *
 * ── AND THE RESPONSE IS DEFAULTED HERE, WHICH IT IS NOWHERE ELSE ────────────────────────────────
 * Every other writer refuses without a customer response, because a silent `not_raised` would mean
 * `declined` — the only answer that is a lead — never appears. That argument is about FINDINGS,
 * discussed with a customer standing at the car.
 *
 * A schedule item is recorded ten months before that conversation happens. There is no answer to
 * give, and making a mechanic tap one for each of six rows is theatre that would also produce six
 * meaningless `not_raised` records rather than one honest absence. So it is defaulted, per shape,
 * with the reason stated — and the distinction is written at BOTH rules so nobody later
 * "harmonises" them into one.
 */

/** Today every entry is transcribed from a service computer. */
export type ScheduleKey =
  | 'schedule_oil_service' | 'schedule_brake_fluid'
  | 'schedule_pads_front' | 'schedule_pads_rear' | 'schedule_vehicle_check';

/**
 * THE BASIS IS DECLARED PER ITEM, not inferred from which fields somebody filled.
 *
 * Each of these has a natural clock and the form should show that clock rather than everything the
 * model permits. Pads cannot be predicted by date; brake fluid cannot be predicted by mileage; an
 * oil service is genuinely both. Offering two fields on every row invited a wrong answer and made
 * the form guess at the basis afterwards — the one deviation this file had from refuseDueItem's
 * refusal to infer. Declaring it removes the guess entirely.
 */
export type ScheduleBasis = 'date' | 'mileage' | 'whichever_first';

export type ScheduleItem = {
  key: ScheduleKey;
  /** The row label, as the service computer names it. */
  label: string;
  /** What lands on the finding, and therefore on the report and the invoice block. */
  description: string;
  /** Declared, never inferred. Decides which fields the row even shows. */
  basis: ScheduleBasis;
  /** Why this clock and not another — shown nowhere, read by whoever changes it. */
  why: string;
};

export const SCHEDULE_ITEMS: readonly ScheduleItem[] = [
  { key: 'schedule_oil_service', label: 'Next oil service', description: 'Next oil service',
    basis: 'whichever_first', why: 'manufacturers specify "12 months or 10,000 miles" — genuinely both' },
  { key: 'schedule_brake_fluid', label: 'Next brake fluid change', description: 'Next brake fluid change',
    basis: 'date', why: 'a two-year interval; fluid absorbs moisture with time, not use' },
  { key: 'schedule_pads_front', label: 'Front brake pads', description: 'Front brake pads',
    basis: 'mileage', why: 'wear is use — you cannot predict by date when pads run out' },
  { key: 'schedule_pads_rear', label: 'Rear brake pads', description: 'Rear brake pads',
    basis: 'mileage', why: 'same as the fronts' },
  // CORRECTED 2026-08-20, and the original reasoning is kept because the reversal is the useful part.
  //
  // This shipped as `date`, on my argument that "a vehicle check is a touchpoint, not a wear item —
  // appointments book by date". That is wrong in the same way it would be wrong for the oil
  // service: a manufacturer's inspection interval is 12 months OR a mileage, whichever comes first,
  // and a car doing 30,000 a year reaches it long before the year is up. Being a touchpoint
  // describes how the appointment is BOOKED, not when the car becomes due — and the schedule
  // records the second, not the first.
  //
  // The second half of the original note stands and now cuts the other way: this is the row that
  // projects with no mileage rate, and only 192 of 221 cars had one (measured 19 Aug 2026). With a
  // mileage leg it will sometimes carry a target it cannot forecast from; mileageLegUnevaluated
  // already says so on the marketing list rather than guessing.
  { key: 'schedule_vehicle_check', label: 'Vehicle check', description: 'Vehicle check',
    basis: 'whichever_first', why: 'an inspection interval is months OR miles, whichever comes first — the same shape as the oil service, and for the same reason' },
];

/**
 * A DATE LEG ON A SCHEDULE ROW IS A MONTH, NEVER A DAY.
 *
 * A service computer prints "11/2025". A dd/mm/yyyy input forces a day nobody has, and the day then
 * prints on a frozen invoice as though somebody chose it. Every date leg here is month-precision;
 * the stored instant is the 1st (see STORED_DAY_OF_MONTH) and due_date_precision records that the
 * day was never meant.
 */
export const SCHEDULE_DATE_IS_MONTH = true;

/**
 * THE DAY STORED FOR A MONTH-PRECISION DATE, and why the 1st rather than the last.
 *
 * Two reasons, and the second is the one that is not obvious — the last-day alternative looks
 * equally arbitrary and is not:
 *
 *   1. It is a real instant, so ordering and effectiveDueDate need no special case.
 *   2. It puts a November item into the 30-day marketing window from 2 OCTOBER. Contacting a
 *      customer before the thing is due is the entire point of the list; storing the last day would
 *      delay every reminder by up to four weeks and surface the car only once it was already late.
 */
export const STORED_DAY_OF_MONTH = 1;

const BY_KEY = new Map(SCHEDULE_ITEMS.map((s) => [s.key, s]));
export const scheduleByKey = (k: string): ScheduleItem | null => BY_KEY.get(k as ScheduleKey) ?? null;
export const SCHEDULE_KEYS: ReadonlySet<string> = new Set(SCHEDULE_ITEMS.map((s) => s.key));

/**
 * THE MOT IS SHOWN, NEVER STORED. Named as a constant so this is a decision a reader finds rather
 * than an omission they assume is a bug — printedDueItemsBlock already leads with the MOT expiry,
 * so a schedule row would put it on the invoice twice.
 */
export const MOT_IS_READ_ONLY = true;

/**
 * "OTHER" WRITES A FREE-TEXT FINDING WITH NO KEY.
 *
 * A garage may have two at once — auto transmission fluid AND diesel additive — and the partial
 * unique index on (group, vehicle, observation_key) would refuse the second. Keying them by slug
 * brings back the naming problem the fixed catalogue exists to avoid, so they go through the
 * existing free-text path: null key, unconstrained, and honestly marked as something a human typed.
 * The cost is that they do not appear in a schedule-shaped count, which is the right trade.
 */
export const OTHER_IS_FREE_TEXT = true;

export type ScheduleEntry = {
  key: ScheduleKey;
  /** `YYYY-MM` — a month, not a day. See SCHEDULE_DATE_IS_MONTH. Null when the row has no date leg
   *  or the garage did not record one. */
  dueMonth: string | null;
  dueMileage: number | null;
  /**
   * What the CLIENT WAS HANDED for this row when its form was seeded — true if a stored reading
   * existed then. Not what the inputs contain now, and not derivable from them: a row the form
   * never loaded and a row the user emptied look identical by the time they reach the wire.
   *
   * Optional ON PURPOSE, and the one place a missing value is not a caller forgetting. A phone
   * can queue a schedule save offline and replay it days later, in the shape it had when it was
   * queued. Rejecting a replayed payload would throw away readings a mechanic actually took;
   * accepting it while declining its CLEARS keeps the writes and drops only the destructive half.
   * Absent therefore means unknown, and unknown never deletes. See classifyEntry.
   */
  wasRecorded?: boolean;
  /**
   * WHAT THE CLUSTER SHOWED, when it showed distance remaining instead of a target. Negative means
   * the service is already behind the car. The SERVER derives `dueMileage` from this and the car's
   * reading — a client must not send both, and if it sends this one, whatever it put in dueMileage
   * is ignored rather than trusted. One conversion, one place.
   */
  countdownMiles?: number | null;
};

/** `YYYY-MM` → the stored instant. Returns null for anything that is not a month. */
export function monthToStoredDate(month: string | null | undefined): Date | null {
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, STORED_DAY_OF_MONTH));
}

/** The stored instant → `YYYY-MM`, for putting a recorded row back into the form. */
export const storedDateToMonth = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString().slice(0, 7) : null;

export type ScheduleRefusal = { key: ScheduleKey; code: 'incomplete' | 'bad_mileage' | 'bad_month'; message: string };

/** Which legs a row must carry, from its declared basis. */
export const legsFor = (basis: ScheduleBasis): { date: boolean; mileage: boolean } => ({
  date: basis === 'date' || basis === 'whichever_first',
  mileage: basis === 'mileage' || basis === 'whichever_first',
});

/**
 * A row is BLANK when none of the legs its basis needs is filled. Blank is not an error — most cars
 * leave most rows empty, and a schedule the garage does not have is not a mistake.
 */
export function isBlank(item: ScheduleItem, e: Pick<ScheduleEntry, 'dueMonth' | 'dueMileage' | 'countdownMiles'>): boolean {
  const legs = legsFor(item.basis);
  // A countdown IS a mileage leg — it is the same fact in the units the screen used. Reading only
  // dueMileage here would call a filled-in countdown row blank, and a blank row is a request to
  // clear. The two features would have combined into a deletion, which is the exact shape of the
  // defect that motivated both of them.
  const hasMileage = e.dueMileage != null || e.countdownMiles != null;
  return !(legs.date && e.dueMonth) && !(legs.mileage && hasMileage);
}

/**
 * ── A COUNTDOWN IS A MEASUREMENT; A DUE MILEAGE IS A CONCLUSION ────────────────────────────────
 * A MINI cluster shows distance REMAINING — "1,240 mi", or "-240 mi" beside "Service overdue" —
 * and never the odometer the service falls due at. Everything downstream understands the target:
 * effectiveDueDate compares `currentMiles >= dueMileage`, dueLabel prints "due at N miles",
 * serviceDue projects a date from it. So the countdown converts, here, once.
 *
 * WHICH READING IT COUNTS FROM IS THE WHOLE THING. "240 miles left" is 240 miles from where the
 * car is NOW — which on arrival is the odometer it came in on, and after the work is the one it
 * leaves on. Counting a departure reading from the arrival figure would understate every target
 * by the length of the job.
 *
 * REFUSE, NEVER GUESS. Both readings are genuinely optional at the moment this is typed: the
 * schedule panel sits on the same tab as the odometer box, in no fixed order, and mileage-out is
 * deliberately EMPTY by default (a measurement, never a default — see lib/odometer). So the
 * absent-odometer path is the common one on Completion, not a corner, and it has to read as the
 * next thing to do rather than as a rejection.
 */
export type CountdownRefusal = { code: 'no_odometer' | 'before_zero'; message: string };
export type CountdownResolution = { ok: true; dueMileage: number } | { ok: false } & CountdownRefusal;

export function resolveCountdown(
  countdownMiles: number,
  odometer: number | null,
  stage: 'arrival' | 'departure',
): CountdownResolution {
  if (!Number.isInteger(countdownMiles)) return { ok: false, code: 'before_zero', message: 'A countdown has to be a whole number of miles.' };
  if (odometer == null) {
    return { ok: false, code: 'no_odometer',
      message: stage === 'arrival'
        ? 'Record the mileage in first — a countdown needs a reading to count from.'
        : 'Record the mileage out first — a countdown needs a reading to count from.' };
  }
  const dueMileage = odometer + countdownMiles;
  // Behind the car is ordinary and is the case this was built for. Behind ZERO is a mis-key —
  // a countdown bigger than the odometer — and storing it would put a nonsense target on a
  // customer document.
  if (dueMileage < 0) {
    return { ok: false, code: 'before_zero',
      message: `${countdownMiles.toLocaleString('en-GB')} miles from ${odometer.toLocaleString('en-GB')} is before the car had any — check the countdown and the odometer.` };
  }
  return { ok: true, dueMileage };
}

/**
 * ── A BLANK ROW IS TWO DIFFERENT SENTENCES ─────────────────────────────────────────────────────
 * "I emptied this" and "I never had this" arrive identically: an entry with no legs filled. The
 * writer used to read both as *clear this item*, which is right for the first and destroyed five
 * real readings for the second — TMBS D13DSK, 21 August, a form that came back stale-empty after
 * a tab switch and was saved:
 *
 *     09:22:48  arrival  written=5  cleared=0
 *     09:23:37  arrival  written=0  cleared=5
 *
 * The seed-once defect behind that is fixed, and the next component to go stale will find the
 * same open trapdoor unless the two sentences are told apart HERE. They cannot be told apart from
 * the values, because the values are what is missing — so the client says which it means, from
 * what it was seeded with rather than from what its inputs happen to contain.
 *
 * Refusing every blank outright would be the wrong fix: clearing a mis-read row is an ordinary
 * thing to do, and a garage that cannot correct a wrong reading will write a wrong one instead.
 *
 * NOT A SECURITY BOUNDARY. `wasRecorded` is a claim by the caller, and a caller that lies can
 * still delete a row it is entitled to delete. It is an INTENT signal, and its whole value is
 * that a stale form has nothing to lie WITH: a form seeded from an empty prop honestly reports
 * false for every row, which is exactly the case that must not delete.
 *
 * WHAT THIS DOES NOT COVER: a form seeded with STALE VALUES rather than none. There, wasRecorded
 * is legitimately true and the client overwrites newer data with older — a lost update, a
 * different defect needing a different mechanism (a version, or the seeded value echoed back).
 * Naming it here so a green gate on this rule is not read as covering that one.
 */
export type EntryAction = 'record' | 'clear' | 'skip';

export function classifyEntry(item: ScheduleItem, e: Pick<ScheduleEntry, 'dueMonth' | 'dueMileage' | 'wasRecorded'>): EntryAction {
  if (!isBlank(item, e)) return 'record';
  return e.wasRecorded === true ? 'clear' : 'skip';
}

/** Said in a sentence, for the audit and for the person reading it later. */
export const SKIPPED_BLANK_REASON =
  'blank, and the client did not report holding a reading for it — treated as nothing to say, not as an erasure';

/**
 * Refuse what cannot be stored. PURE, so every rule is provable without a row.
 *
 * ── A HALF-FILLED whichever_first IS REFUSED, WITH THE REASON ───────────────────────────────────
 * refuseDueItem already refuses it: "one leg alone is a different basis and loses the trigger that
 * would have fired first." An oil service recorded as miles-only, then projected from, is a rule
 * half-recorded and confidently applied — worse than not recording it. The message says which leg
 * is missing rather than saying the row is invalid, because the mechanic can read the other one off
 * the service sticker.
 *
 * The cost, accepted knowingly: a service computer that prints only a mileage leaves that row
 * blank. If that turns out to be common it is evidence to revisit on, not a thing to design around
 * now — recording half a rule and projecting from it is the worse failure.
 */
export function refuseSchedule(entries: Array<ScheduleEntry & { item: ScheduleItem }>): ScheduleRefusal[] {
  const out: ScheduleRefusal[] = [];
  for (const e of entries) {
    const legs = legsFor(e.item.basis);
    if (isBlank(e.item, e)) continue;

    if (legs.mileage && e.dueMileage != null && (!Number.isInteger(e.dueMileage) || e.dueMileage <= 0 || e.dueMileage > 2_000_000)) {
      out.push({ key: e.key, code: 'bad_mileage', message: 'That mileage does not look right.' });
      continue;
    }
    if (legs.date && e.dueMonth != null && monthToStoredDate(e.dueMonth) === null) {
      out.push({ key: e.key, code: 'bad_month', message: 'That month does not look right.' });
      continue;
    }
    if (legs.date && legs.mileage) {
      if (!e.dueMonth) out.push({ key: e.key, code: 'incomplete', message: `${e.item.label} is due at a mileage OR by a month, whichever comes first — give the month as well.` });
      else if (e.dueMileage == null) out.push({ key: e.key, code: 'incomplete', message: `${e.item.label} is due at a mileage OR by a month, whichever comes first — give the mileage as well.` });
    }
  }
  return out;
}
