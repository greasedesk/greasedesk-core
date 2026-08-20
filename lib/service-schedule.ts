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
export function isBlank(item: ScheduleItem, e: Pick<ScheduleEntry, 'dueMonth' | 'dueMileage'>): boolean {
  const legs = legsFor(item.basis);
  return !(legs.date && e.dueMonth) && !(legs.mileage && e.dueMileage != null);
}

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
