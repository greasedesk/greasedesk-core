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

export type MileageRate =
  | { ok: true; milesPerYear: number; spanDays: number; readings: number; from: string; to: string }
  | { ok: false; reason: 'too_few' | 'span_too_short' | 'goes_backwards'; readings: number };

/**
 * Miles per year for a car, or a STATED reason why we cannot say.
 *
 * Every failure returns a reason rather than a number: a projected reminder date built on an
 * invented rate is worse than no date, because it looks like a decision somebody made.
 */
export function mileageRate(readings: OdometerReading[]): MileageRate {
  const sorted = [...readings].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (sorted.length < 2) return { ok: false, reason: 'too_few', readings: sorted.length };
  const first = sorted[0], last = sorted[sorted.length - 1];
  const spanDays = Math.round((last.date.getTime() - first.date.getTime()) / 86_400_000);
  if (spanDays < MIN_SPAN_DAYS) return { ok: false, reason: 'span_too_short', readings: sorted.length };
  const delta = last.miles - first.miles;
  // Clocking, a replacement cluster, or a keying error. No rate, and the caller can say so.
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
    orderBy: { reading_date: 'asc' },
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
