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

export type ScheduleItem = {
  key: ScheduleKey;
  /** The row label, as the service computer names it. */
  label: string;
  /** What lands on the finding, and therefore on the report and the invoice block. */
  description: string;
};

export const SCHEDULE_ITEMS: readonly ScheduleItem[] = [
  { key: 'schedule_oil_service', label: 'Next oil service', description: 'Next oil service' },
  { key: 'schedule_brake_fluid', label: 'Next brake fluid change', description: 'Next brake fluid change' },
  { key: 'schedule_pads_front', label: 'Front brake pads', description: 'Front brake pads' },
  { key: 'schedule_pads_rear', label: 'Rear brake pads', description: 'Rear brake pads' },
  { key: 'schedule_vehicle_check', label: 'Vehicle check', description: 'Vehicle check' },
];

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
  /** ISO date, or null. */
  dueDate: string | null;
  dueMileage: number | null;
};

export type ScheduleRefusal = { key: ScheduleKey; code: 'no_clock' | 'bad_mileage' | 'bad_date'; message: string };

/**
 * WHAT BASIS AN ENTRY HAS, from which legs are filled. Returns null when it has neither.
 *
 * The INFERENCE here is deliberate and is NOT the inference refuseDueItem refuses. That rule exists
 * because a finding's basis must be stated: "by March or 60k" has both legs present and only one
 * binds, so letting the data choose would silently drop the trigger that fires first. A schedule
 * row has no such ambiguity — a service computer prints a date, a mileage, or both, and "both"
 * means whichever comes first, which is exactly what the garage's own proforma meant.
 */
export function basisFor(e: Pick<ScheduleEntry, 'dueDate' | 'dueMileage'>): 'date' | 'mileage' | 'whichever_first' | null {
  const d = !!e.dueDate, m = e.dueMileage != null;
  if (d && m) return 'whichever_first';
  if (d) return 'date';
  if (m) return 'mileage';
  return null;
}

/** An entry with neither leg is not "empty", it is not submitted at all — see refuseSchedule. */
export const isBlank = (e: Pick<ScheduleEntry, 'dueDate' | 'dueMileage'>): boolean => basisFor(e) === null;

/**
 * Refuse what cannot be stored. PURE, so every rule is provable without a row.
 *
 * A BLANK ROW IS NOT AN ERROR — it is a line the garage's schedule did not have, and most cars will
 * leave most rows empty. Only a row with something wrong IN it is refused.
 */
export function refuseSchedule(entries: ScheduleEntry[]): ScheduleRefusal[] {
  const out: ScheduleRefusal[] = [];
  for (const e of entries) {
    if (isBlank(e)) continue;
    if (e.dueMileage != null && (!Number.isInteger(e.dueMileage) || e.dueMileage <= 0 || e.dueMileage > 2_000_000)) {
      out.push({ key: e.key, code: 'bad_mileage', message: 'That mileage does not look right.' });
    }
    if (e.dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(e.dueDate)) {
      out.push({ key: e.key, code: 'bad_date', message: 'That date does not look right.' });
    }
  }
  return out;
}
