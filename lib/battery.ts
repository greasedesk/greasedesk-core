/**
 * File: lib/battery.ts
 * BATTERY CONDITION — the thresholds, the five states three numbers produce, and the decline rate.
 *
 * ── EVERY NUMBER IN THIS FILE IS AN OWNER'S RULE. NONE OF THEM IS LAW. ──────────────────────────
 * This is the difference from lib/tyres, and it is the thing most likely to be misread. A tyre has
 * ONE hard anchor — 1.6mm is the legal minimum, it is not ours to move, and code may treat it as
 * fixed. A battery has NO legal threshold at all. Not one. Every constant below is a garage policy
 * dressed in an industry convention, and a different garage could defensibly set all of them
 * differently. Change them here; do not reason about them as though they were the law.
 *
 * ── THE INTERESTING OUTPUT IS NOT THE HEALTH NUMBER ─────────────────────────────────────────────
 * The naive rule — "health under 50%, sell a battery" — is right about the obvious car and wrong
 * about the one that walks in flat. A conductance tester reads LOW HEALTH ON A DISCHARGED BATTERY,
 * so 11.98V / 0% charge / 17% health is not evidence of a dying battery: it is evidence of a flat
 * one that may or may not recover. Selling on that reading sometimes means selling a battery to
 * someone whose ALTERNATOR is failing, and they are back in three weeks believing it is your fault.
 *
 * So three numbers produce five states, and the two that pay for the design are the ones a
 * single-threshold rule cannot express:
 *
 *   CHARGING_FAULT  low charge, healthy battery — the car is not charging, or is being driven too
 *                   short a distance, or something is draining it. A DIAGNOSTIC sale, not a part.
 *   RETEST          low charge, low health — the health figure is not trustworthy. This state
 *                   REFUSES to advise a replacement. It exists to prevent a wrong sale.
 *
 * Same shape as the alignment advisory in lib/tyres: the valuable finding is the one the obvious
 * model cannot see.
 */

// ── THE CONSTANTS. ALL OWNER RULES — SEE THE HEADER. ─────────────────────────────────────────────

/** Below this resting voltage a cell has failed. Terminal whatever the health figure says. */
export const DEAD_CELL_MV = 10_500;
/** Health at or below which a battery is sold, WHEN the charge state makes health trustworthy. */
export const REPLACE_BELOW_SOH = 50;
/** Health below which it is worth watching. Between this and REPLACE_BELOW_SOH is a note. */
export const MONITOR_BELOW_SOH = 75;
/** Charge at or above which the health reading is trusted at all. */
export const SOH_TRUSTED_ABOVE_SOC = 60;
/** Charge below which, on a HEALTHY battery, something other than the battery is wrong. */
export const CHARGING_FAULT_BELOW_SOC = 50;

/**
 * THE FLOOR ON A RATED CCA, and why it is not zero.
 *
 * The first real user of this form typed 9. It saved: the original bounds were 1–3000, so a rating
 * no car battery has went in silently, and the health percentage was computed against it. Eight per
 * cent of nine is arithmetically fine and physically meaningless.
 *
 * 100 is comfortably below the smallest thing a garage will meet — a small motorcycle battery is
 * around 100–200 CCA and a city car starts near 300 — so this refuses typos without refusing
 * anybody's actual work. It is a bound on the DENOMINATOR specifically, because that is the number
 * everything else is measured against and the only one that cannot be sanity-checked by eye.
 */
export const MIN_RATED_CCA = 100;
export const MAX_RATED_CCA = 3000;

/**
 * ── UNSTATED IS A READING, NOT A MISSING OPTION ─────────────────────────────────────────────────
 * Most UK batteries are labelled just "760 CCA". The Ancel BT410 prints "Rated: 760A CCA" and
 * names no standard either — that is what the mechanic is copying off the screen.
 *
 * The form demanded one of five, and the pairing rule below refuses a rating without a standard,
 * so recording what the label actually says was impossible: guess a standard, drop the rating, or
 * type something to get past it. `UNSTATED` is the honest answer — "the label does not say" is a
 * FACT about the battery, the same shape as every other honest-null in this codebase.
 *
 * It is not a sixth way of rating a battery. It is the absence of one, said out loud, so that a
 * comparison can refuse on it — which is the only place the pairing rule was ever needed.
 */
export type CcaStandard = 'EN' | 'SAE' | 'DIN' | 'JIS' | 'IEC' | 'UNSTATED';
export const CCA_STANDARDS: CcaStandard[] = ['EN', 'SAE', 'DIN', 'JIS', 'IEC', 'UNSTATED'];

/** What a mechanic taps. UNSTATED reads as the label, not as a standard. */
export const CCA_STANDARD_LABEL: Record<CcaStandard, string> = {
  EN: 'EN', SAE: 'SAE', DIN: 'DIN', JIS: 'JIS', IEC: 'IEC',
  UNSTATED: 'Not stated',
};

/**
 * CAN TWO RATINGS BE COMPARED? EN, SAE and DIN rate the same battery differently, so a comparison
 * across standards is meaningless — and so is one where either side does not know its own. This is
 * the entire job the both-or-neither pairing rule was doing, moved to the place that needs it.
 *
 * Nothing compares ratings today (sohDecline compares HEALTH over time, which is a percentage and
 * standard-agnostic). Declared now so the first comparison written cannot forget.
 */
export const ratingsComparable = (a: CcaStandard | null, b: CcaStandard | null): boolean =>
  a != null && b != null && a !== 'UNSTATED' && b !== 'UNSTATED' && a === b;

export type BatteryState = 'ok' | 'monitor' | 'replace' | 'dead_cell' | 'charging_fault' | 'retest';

export type BatteryNumbers = {
  /** Resting voltage in millivolts. */
  voltageMv: number;
  socPct: number;
  sohPct: number;
  ratedCca?: number | null;
  ccaStandard?: CcaStandard | null;
};

/** The photo slots. `JobCardPhoto.slot` is free text, so these need no schema change — the same
 *  inheritance tyre corners got: presign, R2, the phone's replay-safe outbox, presigned reads. */
export const BATTERY_SLOTS = ['battery_voltage', 'battery_result'] as const;
export type BatterySlot = typeof BATTERY_SLOTS[number];
export const BATTERY_SLOT_LABEL: Record<BatterySlot, string> = {
  battery_voltage: 'Voltmeter reading',
  battery_result: 'Test result',
};

export const volts = (mv: number): string => (mv / 1000).toFixed(2);

/**
 * WHICH OF THE FIVE STATES A READING IS IN. Pure and total, so every threshold is provable without
 * writing a row, and so the rule reads in one place rather than being inferred from what happened
 * to get created.
 *
 * Order matters and is deliberate: a dead cell outranks everything (the health figure is
 * meaningless once a cell has gone), and the trust test on charge comes before any judgement that
 * depends on health.
 */
export function batteryState(n: BatteryNumbers): BatteryState {
  if (n.voltageMv < DEAD_CELL_MV) return 'dead_cell';

  const healthTrusted = n.socPct >= SOH_TRUSTED_ABOVE_SOC;

  // NOT THE BATTERY. Healthy cells, poor charge — the fault is upstream of the thing being tested.
  if (n.socPct < CHARGING_FAULT_BELOW_SOC && n.sohPct >= MONITOR_BELOW_SOH) return 'charging_fault';

  // THE REFUSAL. Low charge AND low health: we cannot tell a dying battery from a flat one, and
  // guessing in the direction of a sale is the guess that costs trust.
  if (!healthTrusted && n.sohPct < MONITOR_BELOW_SOH) return 'retest';

  if (healthTrusted && n.sohPct < REPLACE_BELOW_SOH) return 'replace';
  if (healthTrusted && n.sohPct < MONITOR_BELOW_SOH) return 'monitor';

  // The remaining band is charge 50–59 with health at or above 75: a good battery a little down on
  // charge. Named rather than left to fall through, because a silent gap in a state machine is
  // indistinguishable from a missing rule.
  return 'ok';
}

/** True when this state should reach the customer at all. `ok` says nothing; the rest do. */
export const stateRaisesAdvisory = (s: BatteryState): boolean => s !== 'ok';

/**
 * THE URGENCY, in words rather than a fifth due-basis.
 *
 * A battery is the first finding whose natural timing is SEASONAL — "before winter" is not `date`,
 * `mileage`, `next_service` or `whichever_first`. Adding a fifth basis for one item would touch
 * dueLabel, the customer report, the invoice block and the escalation, so the urgency lives in the
 * DESCRIPTION and the basis stays honest.
 *
 * The month is passed in, never read from the clock, so this is testable at a fixed date — and so
 * that telling somebody in January to act "before winter" cannot happen.
 */
export function seasonalUrgency(measuredAt: Date): string {
  const m = measuredAt.getUTCMonth(); // 0 = January
  // December to February: the cold is here, not ahead of us.
  if (m === 11 || m <= 1) return 'replace now — cold starts are what will find it';
  // March to July: winter is far enough away that a deadline would be theatre.
  if (m >= 2 && m <= 6) return 'replace at your convenience';
  // August to November: the useful warning, and the reason this feature is worth building.
  return 'replace before winter';
}

export type BatteryAdvisory = {
  state: BatteryState;
  description: string;
  /** Acting on this cannot wait for the next service. Drives emphasis, never a fabricated date. */
  urgent: boolean;
  /**
   * The description already says WHEN, so appending dueLabel() would contradict it.
   *
   * ── DELIBERATELY NOT `urgent` ───────────────────────────────────────────────────────────────
   * They line up on two of five states and mean different things. A RETEST is not urgent — a flat
   * battery can be charged whenever — but it absolutely carries its own timing ("until it is
   * charged and retested"), and appending "due at the next service" to that is the same
   * contradiction. Reusing a nearby boolean because it happens to match on some cases is how a
   * flag quietly starts meaning something else.
   */
  carriesOwnTiming: boolean;
};

// WHAT THE LABEL SAYS, and no more. With a standard the document names it; with UNSTATED it
// prints the rating alone, because inventing "EN" on a customer's invoice would be asserting
// something the battery does not claim about itself.
const ratedSuffix = (n: BatteryNumbers): string => {
  if (!n.ratedCca || !n.ccaStandard) return '';
  return n.ccaStandard === 'UNSTATED'
    ? ` against ${n.ratedCca} CCA`
    : ` against ${n.ratedCca} CCA ${n.ccaStandard}`;
};

/**
 * WHAT ONE TEST ADVISES. Returns 0 or 1 advisories — unlike a tyre, which can be both worn out and
 * misaligned at once, a battery is in exactly one state.
 */
export function batteryAdvisory(n: BatteryNumbers, measuredAt: Date): BatteryAdvisory | null {
  const state = batteryState(n);
  if (!stateRaisesAdvisory(state)) return null;
  const v = volts(n.voltageMv);
  switch (state) {
    case 'dead_cell':
      // The one case with a TRUE date — see recordBatteryReading. Its own timing is the date the
      // writer attaches, so the label is welcome here and says the same thing twice on purpose.
      return { state, urgent: true, carriesOwnTiming: false, description: `Battery — ${v}V resting, a cell has failed. Replace` };
    case 'replace':
      return { state, urgent: true, carriesOwnTiming: true, description: `Battery — ${n.sohPct}% health${ratedSuffix(n)}, ${seasonalUrgency(measuredAt)}` };
    case 'monitor':
      // NO trailing full stop: this one KEEPS its label, and a description that ends a sentence
      // then has "due at the next service" appended reads as two fragments.
      //
      // ── AND NO FIGURES, WHICH IS THE SPLIT ──────────────────────────────────────────────────
      // This said "Battery — 62% health against 760 CCA EN, worth watching" while the measurement
      // printed the same 62% and the same 760 CCA below it, under a heading that described
      // neither. Once the two sit under separate headings the advisory is the JUDGEMENT and the
      // measurement is its evidence; repeating the numbers made it read as one claim stated twice
      // — on the invoice, on the job card, and on the marketing board row, three times over.
      //
      // `replace` and `dead_cell` KEEP theirs: a resting voltage and a seasonal urgency are part
      // of the judgement, not a restatement of the reading.
      //
      // Invoices already issued keep their old wording. Freeze-at-issue governs content, and a
      // document saying "62% health, worth watching" is correct as it stands — the inconsistency
      // between old and new documents is the freeze working, not a thing to tidy.
      return { state, urgent: false, carriesOwnTiming: false, description: 'Battery — worth watching' };
    case 'charging_fault':
      // NOT a battery sale. Said in the words a customer can act on, because the temptation to sell
      // the part in front of you is exactly what this state exists to resist.
      return {
        state, urgent: false, carriesOwnTiming: true,
        description: `Battery holding only ${n.socPct}% charge but ${n.sohPct}% health — check the charging system and for a drain now, the battery itself is sound`,
      };
    case 'retest':
      return {
        state, urgent: false, carriesOwnTiming: true,
        description: `Battery was at ${n.socPct}% charge when tested (${v}V) — its health cannot be judged until it is charged and retested`,
      };
    default:
      return null;
  }
}

/**
 * THE PRINTED BATTERY LINE for the invoice's frozen advisory block. One line, plain text, for the
 * same reason the tyre lines are text: the block must reprint byte-for-byte, and a structured child
 * table freezes worse than a string.
 */
export function printedBatteryLine(n: BatteryNumbers): string {
  return `Battery — ${volts(n.voltageMv)}V, ${n.socPct}% charge, ${n.sohPct}% health${ratedSuffix(n)}`;
}

// ── THE DECLINE RATE ─────────────────────────────────────────────────────────────────────────────

export type SohDecline =
  | { ok: true; pointsPerMonth: number; from: string; to: string; monthsCovered: number }
  | { ok: false; reason: 'too_few' | 'no_span' | 'gained_health' };

/**
 * HOW FAST THIS BATTERY IS DYING — for THIS car, measured, never assumed.
 *
 * The same refusal as tyreWearRate and for the same reason: a first reading cannot say when. There
 * is a textbook figure available and it would produce a confident date nobody measured, which is
 * the fabricated-constant failure already refused for the video deflation factor. Two readings
 * give a real rate; one gives an honest refusal and the due item sits on `next_service`.
 */
export function sohDecline(readings: Array<{ measuredAt: Date; sohPct: number }>): SohDecline {
  if (readings.length < 2) return { ok: false, reason: 'too_few' };
  const sorted = [...readings].sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  const first = sorted[0], last = sorted[sorted.length - 1];
  const months = (last.measuredAt.getTime() - first.measuredAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 1) return { ok: false, reason: 'no_span' };
  const lost = first.sohPct - last.sohPct;
  // A battery that gained health was REPLACED between visits — a new battery, not a recovering one.
  if (lost <= 0) return { ok: false, reason: 'gained_health' };
  return {
    ok: true,
    pointsPerMonth: Math.round((lost / months) * 100) / 100,
    from: first.measuredAt.toISOString().slice(0, 10),
    to: last.measuredAt.toISOString().slice(0, 10),
    monthsCovered: Math.round(months * 10) / 10,
  };
}

/** The date this battery is projected to cross the replace threshold, or null when we cannot say. */
export function projectedReplaceDate(currentSoh: number, from: Date, decline: SohDecline): Date | null {
  if (!decline.ok || decline.pointsPerMonth <= 0) return null;
  const remaining = currentSoh - REPLACE_BELOW_SOH;
  if (remaining <= 0) return from;
  const months = remaining / decline.pointsPerMonth;
  // Beyond about three years the projection is a straight line through noise, not a forecast.
  if (months > 36) return null;
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + Math.round(months));
  return d;
}

// ── THE WRITER ───────────────────────────────────────────────────────────────────────────────────
import type { Prisma } from '@prisma/client';
import { BATTERY_KEY } from '@/lib/observation-keys';


/**
 * Record a battery test and raise what it advises. ONE writer, so a reading cannot exist without
 * its advisory having been considered.
 *
 * ── THE BASIS UPGRADES ITSELF ───────────────────────────────────────────────────────────────────
 * `next_service` until this car's OWN decline rate exists (two readings spanning a month), then
 * `date` at the projected crossing. Nothing to revisit: the next test does it.
 *
 * ── AND IT DOES NOT DUPLICATE ───────────────────────────────────────────────────────────────────
 * Retesting on the same visit replaces the reading (unique on job_card_id) and must not stack a
 * second advisory. An OPEN battery item is updated in place. A test that comes back `ok` CLOSES the
 * open item rather than leaving last visit's warning standing against a battery since replaced.
 */
export async function recordBatteryReading(
  tx: Prisma.TransactionClient,
  args: {
    groupId: string; vehicleId: string; jobCardId: string; measuredBy: string | null;
    reading: BatteryNumbers;
    /** Passed in, never read from the clock — so the seasonal wording is testable at a fixed date. */
    measuredAt?: Date;
  },
): Promise<{ state: BatteryState; advisory: boolean; basis: 'date' | 'next_service' | null }> {
  const at = args.measuredAt ?? new Date();
  const t = tx as Prisma.TransactionClient;

  // ── THE RATING IS THE CAR'S, AND A BLANK MUST NOT ERASE IT ────────────────────────────────────
  // An absent rating means NOBODY SUPPLIED ONE, not "this car has no rating". Writing the null
  // through would destroy a denominator on the second visit — and the whole argument for capturing
  // it is that it cannot be retrofitted, so erasing it is the one unrecoverable thing this writer
  // could do. A real test caught exactly that: a retest with the rating left blank blanked it.
  //
  // Inherited HERE rather than fixed in the capture form, deliberately. A UI prefill is a
  // convenience that can fail quietly — stale cache, a cleared field, a second surface built later.
  // The writer is the guarantee, and every caller gets it.
  let n = args.reading;
  if (n.ratedCca == null) {
    const known = await t.batteryReading.findFirst({
      where: { group_id: args.groupId, vehicle_id: args.vehicleId, rated_cca: { not: null } },
      orderBy: { measured_at: 'desc' },
      select: { rated_cca: true, cca_standard: true },
    });
    // Both or neither, still: the pair is the unit of meaning, and the database enforces it too.
    if (known?.rated_cca != null && known.cca_standard != null) {
      n = { ...n, ratedCca: known.rated_cca, ccaStandard: known.cca_standard as CcaStandard };
    }
  }

  await t.batteryReading.upsert({
    where: { job_card_id: args.jobCardId },
    create: {
      group_id: args.groupId, vehicle_id: args.vehicleId, job_card_id: args.jobCardId,
      voltage_mv: n.voltageMv, soc_pct: n.socPct, soh_pct: n.sohPct,
      rated_cca: n.ratedCca ?? null, cca_standard: (n.ccaStandard ?? null) as never,
      measured_at: at, measured_by: args.measuredBy,
    },
    update: {
      voltage_mv: n.voltageMv, soc_pct: n.socPct, soh_pct: n.sohPct,
      rated_cca: n.ratedCca ?? null, cca_standard: (n.ccaStandard ?? null) as never,
      measured_at: at, measured_by: args.measuredBy,
    },
  });

  const advisory = batteryAdvisory(n, at);
  // BY KEY, not by description prefix. The prefix version matched prose: a hand-typed "Battery
  // terminals corroded" is an open finding starting with "Battery", so the next test rewrote the
  // mechanic's own observation into a battery advisory, silently.
  const existing = await t.vehicleDueItem.findFirst({
    where: {
      group_id: args.groupId, vehicle_id: args.vehicleId, closed_at: null,
      observation_key: BATTERY_KEY,
    },
    select: { id: true },
  });

  if (!advisory) {
    // A healthy test on a car that had an open battery warning means the battery was replaced, or
    // the earlier reading was the RETEST case and charging cleared it. Either way the warning is
    // no longer true, and leaving it standing would put a stale line on the next invoice.
    if (existing) {
      await t.vehicleDueItem.update({
        where: { id: existing.id },
        data: { closed_at: at, closed_job_card_id: args.jobCardId, closed_reason: 'Retested and sound' },
      });
    }
    return { state: batteryState(n), advisory: false, basis: null };
  }

  // THE DECLINE RATE, for THIS car — from history, never a textbook figure.
  const history = await t.batteryReading.findMany({
    where: { group_id: args.groupId, vehicle_id: args.vehicleId },
    orderBy: { measured_at: 'asc' },
    select: { measured_at: true, soh_pct: true },
  });
  const decline = sohDecline(history.map((h) => ({ measuredAt: h.measured_at, sohPct: h.soh_pct })));
  // Only a MONITOR battery gets a projected date, and that is the whole point of the state: it is
  // the one still ABOVE the replace threshold and heading for it, so there is a crossing to
  // predict. A `replace` battery is already past it — a date would be in the past. A charging fault
  // and a retest are about something other than a countdown to failure.
  const projected = advisory.state === 'monitor' ? projectedReplaceDate(n.sohPct, at, decline) : null;

  // ── A FAILED CELL IS DUE TODAY, AND THE ROW SHOULD SAY SO ─────────────────────────────────────
  // Suppressing the label on the document while storing `next_service` would fix the sentence and
  // leave the ORDERING wrong: effectiveDueDate would sort a dead battery behind a tyre due at
  // 60,000 miles. The measurement date is a true date — not a fabricated deadline like a November
  // "before winter" would be — so this case needs no suppression at all. Saying "due by 19 August"
  // beside "a cell has failed" is a restatement, not a contradiction.
  const dueDate = advisory.state === 'dead_cell' ? at : projected;
  const data = {
    observation_key: BATTERY_KEY,
    description: advisory.description,
    due_basis: (dueDate ? 'date' : 'next_service') as 'date' | 'next_service',
    due_date: dueDate,
    timing_in_description: advisory.carriesOwnTiming,
  };

  if (existing) {
    await t.vehicleDueItem.update({ where: { id: existing.id }, data });
  } else {
    await t.vehicleDueItem.create({
      data: {
        group_id: args.groupId, vehicle_id: args.vehicleId, found_on_job_card_id: args.jobCardId,
        // NO DEFAULT is possible here in the way the capture surfaces enforce it, because nobody has
        // been asked yet — `not_raised` is the truthful state of a machine-raised advisory, and the
        // response_at stays null because there was no answering event.
        customer_response: 'not_raised' as never,
        created_by: args.measuredBy,
        ...data,
      },
    });
  }
  return { state: advisory.state, advisory: true, basis: data.due_basis };
}
