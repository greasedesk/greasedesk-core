/**
 * File: lib/oil-level.ts
 * WHERE THE OIL IS ON THE DIPSTICK — five readings, three of which are worth telling someone about.
 *
 * ── WHY THIS IS NOT A TAP-OBSERVATION ───────────────────────────────────────────────────────────
 * Every entry in lib/observations is tapped ONLY WHEN IT IS TRUE. Nobody taps "wipers fine". But
 * "check the oil level" is a prompt to LOOK, and "checked, it's fine" is a meaningful record that
 * no-tap cannot express — the same argument that made "nothing found" its own artefact rather than
 * an absence. Putting it in the tap list would break that list's contract, and a list where one
 * item behaves differently is a list you can no longer trust at speed.
 *
 * So it is a CHECKLIST ITEM: prompted per site, switchable off by a garage that does not want it,
 * and satisfied by a recorded level, so it reaches the escalation (lib/intake-escalation) with
 * no extra wiring.
 *
 * ── AND WHY IT IS NOT A TABLE, THOUGH TYRES AND BATTERY ARE ─────────────────────────────────────
 * Those earned tables on TRAJECTORY — a wear rate, a decline rate, series you can only get from
 * history. Oil level has no equivalent: the interesting series would be CONSUMPTION between
 * top-ups, and nothing records a top-up. A table would be built on a measurement nobody takes.
 * The level is recorded as an audit event and a finding is raised only when there is something to
 * do about it — exactly the shape `intake.nothing_found` already uses.
 *
 * ── THE ONE A YES/NO MODEL MISSES ───────────────────────────────────────────────────────────────
 * ABOVE MAXIMUM. Overfilling is a real fault — it aerates the oil, can push out seals and foul the
 * catalyst — and "is the oil low?" cannot see it. Same shape as the alignment advisory and the
 * charging-fault state: the finding worth having is the one the obvious question does not ask.
 */

/** Bottom to top, and the order they are shown in. */
export const OIL_LEVELS = ['below_min', 'at_min', 'between', 'at_max', 'above_max'] as const;
export type OilLevel = typeof OIL_LEVELS[number];

export const OIL_LEVEL_LABEL: Record<OilLevel, string> = {
  below_min: 'Below min',
  at_min: 'At min',
  between: 'Between',
  at_max: 'At max',
  above_max: 'Over max',
};

/**
 * What each reading advises, or NULL for the two that need nothing.
 *
 * TOTAL over the union, so adding a sixth reading fails to compile until its rule is written — the
 * same discipline as intakeItemDone. Descriptions follow the observation rule: describe what was
 * seen, never name the cause. "Oil level below the minimum mark", not "engine burning oil".
 */
export function oilLevelAdvisory(level: OilLevel): { description: string; urgent: boolean } | null {
  switch (level) {
    case 'below_min':
      return { description: 'Oil level below the minimum mark', urgent: true };
    case 'at_min':
      return { description: 'Oil level at the minimum mark', urgent: false };
    case 'above_max':
      // NOT "overfilled by the last garage" — that is a cause, and we do not know it.
      return { description: 'Oil level above the maximum mark', urgent: false };
    case 'between':
    case 'at_max':
      return null;
  }
}

/** The observation key each advisory carries, so it counts across the book like any other. */
export const OIL_LEVEL_KEY = 'oil_level';

/** True when this reading is worth telling the customer about. */
export const oilLevelRaisesAdvisory = (level: OilLevel): boolean => oilLevelAdvisory(level) !== null;

export const isOilLevel = (v: unknown): v is OilLevel => OIL_LEVELS.includes(v as OilLevel);
