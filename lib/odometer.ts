/**
 * File: lib/odometer.ts
 * ODOMETER READINGS AND THE MILEAGE RATE — the normalisation at the boundary, and the rule that
 * decides when we are entitled to project a car's mileage forward at all.
 *
 * ── WHY A RATE IS LOAD-BEARING, NOT AN ENHANCEMENT ──────────────────────────────────────────────
 * A garage writes "Oil service due in 10k miles or 11/2025" — whichever comes first. Without a
 * mileage rate you cannot know which comes first, so a `whichever_first` due item cannot be ordered
 * by date at all. On a real TMBS invoice four of six due items carried a mileage; only two were
 * orderable without one.
 *
 * ── THE RATE IS COMPUTED OVER THE LONGEST SPAN, NOT CONSECUTIVE PAIRS ───────────────────────────
 * An MOT failure and its retest days later produce two readings a few miles apart. Across
 * CONSECUTIVE pairs that is catastrophic — 40 miles in three days projects to ~4,900 a year. Across
 * the whole span (latest − earliest ÷ years between) a retest cannot distort anything, because it
 * is neither endpoint on any history longer than itself. That is why the retests are NOT deduped
 * on the way in: a retest is a real reading that really happened, deleting it loses a fact the
 * garage may want to see, and the rule belongs at the read. Dedupe for DISPLAY only.
 *
 * ── THE LAG, STATED SO NOBODY "IMPROVES" IT BLIND ───────────────────────────────────────────────
 * A whole-history rate LAGS a change in use: a commuter car that becomes a weekend car keeps a high
 * rate for years, and its reminders fire early. A recent window (say the last two readings, or
 * three years) tracks the change but is noisier — and on a car with one MOT a year, "recent" is
 * two points, which is exactly where a retest pair does its damage.
 *
 * Whole-history is the deliberate starting choice: stable, and wrong in a direction that reminds
 * too early rather than too late. Revisit it ON EVIDENCE, not on instinct — and know that the
 * readings are all stored, so the rule can change without re-fetching anything.
 *
 * ── A GARAGE'S HISTORY ARRIVES AS CARS DO, NOT ON DAY ONE ───────────────────────────────────────
 * Readings land on the FIRST LOOKUP for a car, not retroactively: a first lookup on an unknown
 * registration has no vehicle record to attach to, and there is deliberately no backfill (it would
 * mean re-querying DVSA for every vehicle on file, for cars that may never return).
 *
 * So a new tenant's rate coverage — and therefore the marketing list built on it — is THIN at first
 * and thickens as their book cycles through. That is the honest position and it belongs in the
 * pitch rather than being discovered: "this gets better every time a car comes in", never implied
 * to work fully on day one. A garage told the truth waits; a garage told otherwise concludes the
 * feature is broken.
 */

/**
 * THE FLOOR — below this we decline to infer an annual rate from two points.
 *
 * ── WHAT IT IS ACTUALLY DEFENDING AGAINST ───────────────────────────────────────────────────────
 * Fail-and-retest pairs, which sit 1–14 days apart. That is the whole hazard. Note that the floor
 * only does any work when the span IS the entire history: on a car with years of MOTs the
 * whole-span rule above has already made a retest harmless, because a retest is never an endpoint.
 *
 * ── WHY 90 AND NOT THE ORIGINAL 180 ─────────────────────────────────────────────────────────────
 * 180 was the first figure, chosen before there was any real data to test it against. On TMBS it
 * excluded 100% of the repeat-visit pairs in the book — 30 vehicles, spans of at most 121 days,
 * median 33 — and it excluded them because the tenant's card history was five months old, NOT
 * because the pairs were unreliable. A 121-day pair is an order of magnitude past the retest gap
 * it was written to catch: 4,000 miles over four months is a signal, not noise.
 *
 * ── WHAT 90 COSTS: SEASONALITY ──────────────────────────────────────────────────────────────────
 * A quarter is short enough for the season to bias it. A car measured across a summer of touring
 * over-projects against one that hibernates each winter — call it ±30% either way. That is
 * ACCEPTABLE FOR WHAT THIS FEEDS: a reminder that says "your discs are due around March" is a
 * prompt, not a booking, and being a month out costs nothing. It would NOT be acceptable for
 * anything a customer is charged against, and this figure must not be reused for that without
 * revisiting the trade.
 *
 * Same standing as the whole-history lag above: change it on EVIDENCE, and know what it costs.
 */
export const MIN_SPAN_DAYS = 90;

export type OdometerReading = { date: Date; miles: number; source?: string };

/**
 * DVSA's odometer, normalised to MILES — or null.
 *
 * NULL IS THE POINT of three of these branches. An unreadable odometer stored as 0 reads as a real
 * reading and drags any rate through the floor; an unrecognised unit stored as a bare number
 * silently treats kilometres as miles. Honest-null: we did not learn a mileage.
 */
export function normaliseOdometer(
  value: unknown,
  unit: unknown,
  resultType?: unknown,
): number | null {
  // DVSA says the odometer could not be read (NOT_READABLE / NO_ODOMETER). That is not a zero.
  const rt = String(resultType ?? '').toUpperCase();
  if (rt && rt !== 'READ') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit ?? '').trim().toLowerCase();
  if (u === 'mi' || u === 'miles') return Math.round(n);
  if (u === 'km' || u === 'kilometres' || u === 'kilometers') return Math.round(n * 0.621371);
  // An unrecognised unit is not an invitation to assume miles.
  return null;
}

/**
 * ── CARRIED FORWARD, FOR THE FIRST SURFACE THAT DISPLAYS A RATE ─────────────────────────────────
 * A rate of 0 mi/yr must NOT be rendered as "0 miles/year". Say "hasn't moved between readings".
 *
 * "0 mi/yr" implies a measurement; the honest reading is that two odometer values were identical.
 * That happens for a genuinely stationary car — and it also happens when a mechanic looks at last
 * visit's mileage and types it again rather than reading the clock.
 *
 * CORRECTED 2026-08-19, and worth saying why. This previously read "TMBS already has one (LB14FJX,
 * two identical readings 121 days apart) out of the first three rates the backfill produced" — an
 * accurate observation about a real car, framed as a finding from a backfill that had not been run.
 * It has now run. LB14FJX is real: 115,964 on 21 April and again on 20 August, both visit readings.
 * And "probably not rare" understated it — 65 of TMBS's 221 cars carry an identical consecutive
 * pair, 81 pairs in all, measured 19 Aug 2026 against STORED readings after the backfill. Nearly a
 * third of the fleet. A dated count ages visibly; "probably not rare" was a guess wearing a
 * number's clothes.
 *
 * Nothing downstream is at risk today — projectMileageDate already returns null for a zero rate, so
 * no date is ever invented from one. This is a WORDING obligation for whoever first puts a rate on
 * a screen, recorded here rather than remembered separately.
 */
export type MileageRate =
  | { ok: true; milesPerYear: number; spanDays: number; readings: number; from: string; to: string }
  | { ok: false; reason: 'too_few' | 'span_too_short' | 'goes_backwards' | 'endpoints_disagree'; readings: number };

/**
 * Miles per year for a car, or a STATED reason why we cannot say.
 *
 * Every failure returns a reason rather than a number: a projected reminder date built on an
 * invented rate is worse than no date, because it looks like a decision somebody made.
 */
/**
 * ── ON THE SAME DATE, THE VISIT READING SORTS LAST ─────────────────────────────────────────────
 * A visit reading is keyed off the dash by the garage, with the car in front of them. An MOT figure
 * is transcribed onto a certificate and may be rounded, or taken before the test rather than after.
 * Same date, so neither is more recent — but the visit one is the better-attested endpoint, and
 * only the endpoints set the rate.
 *
 * WHY IT IS A RULE AND NOT AN ACCIDENT: it used to be neither. `mileageRate` sorted by date alone
 * and readingsForVehicle ordered by reading_date alone, so two readings sharing a date sat in
 * whatever order Postgres returned — and Array.sort being stable preserved it. A car with an MOT
 * and a visit on one day got a clean rate or `endpoints_disagree` depending on the run: 110,250
 * last is a climb, 110,000 last reads as a step backwards. odometer-gate caught it as 1 of 30 in a
 * tier run while passing on its own, which is what an undefined order looks like from outside.
 *
 * The rank is the source of truth, NOT the alphabet. `mot` < `visit` alphabetically, which is why
 * the Prisma `orderBy` below can express this at all — a coincidence worth naming, because a third
 * source whose name sorted between them would silently split the two orderings. odometer-gate
 * asserts the two agree.
 */
export const READING_SOURCE_ORDER: Record<string, number> = { mot: 0, visit: 1 };
const sourceRank = (s?: string): number => READING_SOURCE_ORDER[s ?? ''] ?? 0;

/**
 * TOTAL, so the pure function has no undefined pairs left. Date, then source, then miles — the last
 * of those is unreachable for stored rows (recordOdometerReadings collapses same-day same-source
 * readings, so the pair cannot exist in the database) and is here so an arbitrary array passed by a
 * caller sorts the same way twice.
 */
export const compareReadings = (a: OdometerReading, b: OdometerReading): number =>
  a.date.getTime() - b.date.getTime()
  || sourceRank(a.source) - sourceRank(b.source)
  || a.miles - b.miles;

export function mileageRate(readings: OdometerReading[]): MileageRate {
  const sorted = [...readings].sort(compareReadings);
  if (sorted.length < 2) return { ok: false, reason: 'too_few', readings: sorted.length };
  const first = sorted[0], last = sorted[sorted.length - 1];
  const spanDays = Math.round((last.date.getTime() - first.date.getTime()) / 86_400_000);
  if (spanDays < MIN_SPAN_DAYS) return { ok: false, reason: 'span_too_short', readings: sorted.length };
  // ── AN ENDPOINT THAT ARGUES WITH ITS NEIGHBOUR IS NOT A RATE ──────────────────────────────────
  // Only the FIRST and LAST readings set the rate; everything between is never consulted. So a
  // mis-keyed value in the middle is harmless, and the same value at either end silently moves the
  // answer — while still looking like a measurement.
  //
  // Measured 19 Aug 2026 against STORED readings on TMBS's 221 cars, after the DVSA backfill: 22
  // carry a backward step and 11 of those sit at an endpoint. (The first pass said 48 and 12 — it
  // counted same-day retests that collapse on storage and never reach the database. A measurement
  // against the wrong population still reads as a measurement.)
  // Three of the eleven move the rate by 14.8%, 17.7% and 21.5%, and all three end in a
  // ROUNDED visit mileage — 45,000, 110,000, 165,000 — a mechanic writing a round number rather
  // than reading the clock. On a car doing 8,000 a year that is months of error in a projected date.
  //
  // ── WHY IT REFUSES RATHER THAN REPAIRS ────────────────────────────────────────────────────────
  // Two repairs were considered and both fail. Preferring an MOT reading over a nearby visit one
  // fixes NONE of the three that matter: they have no MOT reading nearby, so the bad visit value
  // genuinely is the most recent thing known. Dropping trailing non-monotonic readings fixes all
  // three and breaks the honest case — NA13ODW drops 270,022 miles and VO14OYG 82,875, which is a
  // replaced instrument cluster, and discarding everything after it computes a rate from
  // pre-replacement data with no signal at all.
  //
  // And the two cannot be told apart by size: 3,864 and 4,912 are roundings, 6,318 and 8,619 are
  // mid-history noise, 82,875 is a replacement. Any threshold would be a constant fitted to eleven
  // cars, which is the fabricated-constant failure this file already refuses elsewhere.
  //
  // So: no threshold, no repair, a stated reason — the same family as `too_few` and
  // `span_too_short`. It costs nothing a garage notices: a car with no rate falls into the
  // servicing list's TRIGGER band (lib/marketing-lists) and is still on the call list, just without
  // a projected date it should never have had.
  //
  // NOT BUILT — THE HONEST ALTERNATIVE, if those eleven cars ever matter: surface the conflict to
  // the garage rather than resolve it. "These two readings disagree — 110,000 on 22 July and
  // 113,864 in May. Which is right?" is a question a human can answer in two seconds and we cannot
  // answer at all. That is a feature with a screen and a write path, and it belongs in its own
  // slice; it is emphatically not a constant.
  if (sorted.length >= 3) {
    const firstSuspect = sorted[1].miles < sorted[0].miles;
    const lastSuspect = sorted[sorted.length - 1].miles < sorted[sorted.length - 2].miles;
    if (firstSuspect || lastSuspect) return { ok: false, reason: 'endpoints_disagree', readings: sorted.length };
  }

  const delta = last.miles - first.miles;
  // Clocking, a replacement cluster, or a keying error. No rate, and the caller can say so. With
  // exactly two readings this is the only shape a disagreement can take, which is why the check
  // above needs three.
  if (delta < 0) return { ok: false, reason: 'goes_backwards', readings: sorted.length };
  return {
    ok: true,
    milesPerYear: Math.round((delta / spanDays) * 365),
    spanDays, readings: sorted.length,
    from: first.date.toISOString().slice(0, 10),
    to: last.date.toISOString().slice(0, 10),
  };
}

/**
 * When will this car reach a target mileage? NULL when we have no rate, or the target is already
 * behind us, or the rate is zero (a car that has not moved will never arrive).
 */
export function projectMileageDate(
  currentMiles: number | null | undefined,
  targetMiles: number,
  rate: MileageRate,
  now: Date,
): Date | null {
  if (!rate.ok || rate.milesPerYear <= 0) return null;
  if (currentMiles == null || !Number.isFinite(currentMiles)) return null;
  const remaining = targetMiles - currentMiles;
  if (remaining <= 0) return null;
  return new Date(now.getTime() + (remaining / rate.milesPerYear) * 365 * 86_400_000);
}

/**
 * DISPLAY dedupe — the retests, collapsed for a human reading a list. Same source and the same
 * mileage within a short window is one event to a person and two facts to the database; this is
 * the only place the two views are allowed to differ.
 */
export function dedupeForDisplay(readings: OdometerReading[], withinDays = 30): OdometerReading[] {
  const sorted = [...readings].sort((a, b) => b.date.getTime() - a.date.getTime());
  const out: OdometerReading[] = [];
  for (const r of sorted) {
    const dup = out.find((k) => k.source === r.source && k.miles === r.miles
      && Math.abs(k.date.getTime() - r.date.getTime()) / 86_400_000 <= withinDays);
    if (!dup) out.push(r);
  }
  return out;
}

// ── PERSISTENCE ──────────────────────────────────────────────────────────────────────────────────
import type { Prisma } from '@prisma/client';

type Db = { vehicleOdometerReading: {
  upsert: (a: unknown) => Promise<unknown>;
  findMany: (a: unknown) => Promise<unknown>;
} };

/**
 * Store readings for a car. IDEMPOTENT BY CONSTRUCTION — the DVSA lookup fires on every reg search,
 * so this runs repeatedly for the same car and must converge rather than accumulate. The unique key
 * is (vehicle, source, date); a re-fetch updates the mileage in place if DVSA ever corrects one.
 *
 * Returns how many rows were touched, so a caller can log what a lookup actually learned.
 */
/**
 * ── WHAT MILEAGE THE CAR LEFT ON, AND WHETHER ANYBODY LOOKED ────────────────────────────────────
 *
 * The departure mileage USED TO BE PREFILLED with the arrival mileage on the Completion form, on
 * the argument that it "keeps the car's mileage timeline gapless". Saving the prefilled box stored
 * arrival-equals-departure, and that made two different facts identical in the record:
 *
 *     "I read the dash and it hadn't moved"      — a measurement, and a normal one for a service
 *     "I pressed save without looking"           — no measurement at all
 *
 * On a field whose only purpose is to be a measurement, a default indistinguishable from a
 * confirmation is the honest-null rule broken in the other direction. The box now starts EMPTY
 * with the arrival figure shown beside it as context, so NULL means "not taken", a value means
 * somebody looked, and equal-to-arrival is a finding rather than an artefact.
 *
 * ── AND THE GAPLESS-TIMELINE FALLBACK LIVES HERE, WHERE IT IS VISIBLE ───────────────────────────
 * This is that fallback, moved from a stored default to a read-time one. It returns the BASIS
 * alongside the number, so a consumer can never mistake an assumption for a reading — which is
 * exactly what the stored version made impossible.
 *
 * Nothing consumes it yet: on 2026-08-20 `odometer_out` had precisely one reader (the form that
 * writes it) and never reached VehicleOdometerReading at all — only arrival mileages do, via
 * pages/api/jobcard-details. So the stored default was smoothing a timeline that nothing read.
 *
 * ── A PERMANENT LIMIT ON ANY ANALYSIS OF DEPARTURE MILEAGE ──────────────────────────────────────
 * Measured on TMBS, 20 August 2026: 31 of 214 completed cards carried an `odometer_out` at all,
 * and 24 of those 31 equalled the arrival figure. Because the prefill made an accepted default
 * identical to a typed confirmation, and there is no audit row or timestamp on the column, THOSE
 * 24 ROWS ARE PERMANENTLY AMBIGUOUS and cannot be salvaged as evidence of anything. The 4 that
 * differ are the only unambiguous departure mileages in the data, and by construction they are the
 * cars that moved — so they cannot tell you how often the reading is genuinely taken either.
 *
 * "31 of 214" is therefore an UPPER BOUND on how often anyone looked, not a capture rate. Any
 * figure computed from rows created before this date inherits that bound; rows created after it
 * do not.
 */
export type VisitEndMileage =
  | { miles: number; basis: 'measured' }
  /** No departure reading taken. The arrival figure, offered as the best available — SAY SO. */
  | { miles: number; basis: 'assumed_unchanged' }
  | { miles: null; basis: 'unknown' };

export function visitEndMileage(card: { odometerIn: number | null; odometerOut: number | null }): VisitEndMileage {
  if (card.odometerOut != null) return { miles: card.odometerOut, basis: 'measured' };
  if (card.odometerIn != null) return { miles: card.odometerIn, basis: 'assumed_unchanged' };
  return { miles: null, basis: 'unknown' };
}

export async function recordOdometerReadings(
  db: Prisma.TransactionClient | Db,
  args: { groupId: string; vehicleId: string; source: 'mot' | 'visit'; readings: Array<{ date: string | Date; miles: number }> },
): Promise<number> {
  let n = 0;
  for (const r of args.readings) {
    const date = r.date instanceof Date ? r.date : new Date(`${r.date}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || !Number.isInteger(r.miles) || r.miles <= 0) continue;
    await (db as Db).vehicleOdometerReading.upsert({
      where: { vehicle_id_source_reading_date: { vehicle_id: args.vehicleId, source: args.source, reading_date: date } },
      create: { group_id: args.groupId, vehicle_id: args.vehicleId, source: args.source, reading_date: date, miles: r.miles },
      update: { miles: r.miles },
    });
    n += 1;
  }
  return n;
}

/** Every reading we hold for a car, oldest-first — the rate's input, and the display list's. */
export async function readingsForVehicle(
  db: Prisma.TransactionClient | Db,
  groupId: string,
  vehicleId: string | null | undefined,
): Promise<OdometerReading[]> {
  if (!vehicleId) return [];
  const rows = (await (db as Db).vehicleOdometerReading.findMany({
    where: { group_id: groupId, vehicle_id: vehicleId },
    // THE SAME ORDER THE PURE SORT USES — see compareReadings. Both, because a tiebreak in one
    // and not the other leaves every reader of the other with an undefined order. `source: 'asc'`
    // expresses the rank only because 'mot' < 'visit' alphabetically; the rank is the rule and
    // odometer-gate asserts the two cannot drift apart.
    orderBy: [{ reading_date: 'asc' }, { source: 'asc' }, { miles: 'asc' }],
    select: { reading_date: true, miles: true, source: true },
  })) as Array<{ reading_date: Date; miles: number; source: string }>;
  return rows.map((r) => ({ date: r.reading_date, miles: r.miles, source: r.source }));
}

/** The rate for a car, straight from what we hold. The one call a caller normally wants. */
export async function mileageRateForVehicle(
  db: Prisma.TransactionClient | Db,
  groupId: string,
  vehicleId: string | null | undefined,
): Promise<MileageRate> {
  return mileageRate(await readingsForVehicle(db, groupId, vehicleId));
}
