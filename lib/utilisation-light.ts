/**
 * File: lib/utilisation-light.ts
 * THE traffic light on the capacity panel: one judgement, one place, so the colour and the
 * thresholds that produced it can never be stated twice.
 *
 * ── IT JUDGES THE CHART'S OWN NUMBERS ───────────────────────────────────────────────────────────
 * sold-to-date ÷ available-to-date, taken from the SAME cumulative series the chart plots, at the
 * SAME elapsed day the chart draws to. Not the whole month's capacity: mid-month that would divide
 * today's sold hours by a month nobody has worked yet and report a garage as failing every time it
 * looked. A light that disagreed with the graph beside it would be worse than no light.
 *
 * For a CLOSED month elapsed is the last day, so to-date and whole-month coincide — which is why
 * TMBS July reads 44.66% either way.
 *
 * ── NO CAPACITY IS NOT NO UTILISATION ───────────────────────────────────────────────────────────
 * Zero available hours means nobody was rostered to sell any. The ratio is undefined, not zero, and
 * a red light would accuse a garage of failing at something it was never open to do. Returns null,
 * and the panel shows nothing. Same for a period that predates the tenant's records — that is
 * answered earlier, by lib/tenant-data-start, which leaves the whole panel absent.
 *
 * ── THE LIGHT IS NOT A SECOND COPY OF THE NUMBER ────────────────────────────────────────────────
 * The percentage already renders in the utilisation tile. This returns a COLOUR and the thresholds
 * behind it, never a formatted figure — a judgement on the number, not a restatement of it.
 */

export type UtilisationColour = 'red' | 'amber' | 'green';

/** Defaults: red below 50%, amber 50–75%, green above 75%. Percentages, not fractions. */
export const DEFAULT_UTIL_RED_BELOW = 50;
export const DEFAULT_UTIL_AMBER_BELOW = 75;

export type UtilisationThresholds = { redBelow: number; amberBelow: number };

export const defaultThresholds = (): UtilisationThresholds => ({
  redBelow: DEFAULT_UTIL_RED_BELOW,
  amberBelow: DEFAULT_UTIL_AMBER_BELOW,
});

/**
 * A garage that inverts them gets a REFUSAL, not nonsense: with red ≥ amber the amber band is empty
 * and every figure is red or green, which looks like a working light and isn't. Both must also be
 * real percentages — 0 and 100 are allowed (a garage may want no red band, or no green one).
 */
export type ThresholdRefusal = { code: 'inverted' | 'out_of_range'; message: string };

export function validateThresholds(redBelow: unknown, amberBelow: unknown): ThresholdRefusal | null {
  const r = Number(redBelow), a = Number(amberBelow);
  if (![r, a].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) {
    return { code: 'out_of_range', message: 'Both thresholds must be percentages between 0 and 100.' };
  }
  if (r >= a) {
    return {
      code: 'inverted',
      message: `The red threshold must be below the amber one. Red below ${r}% and amber below ${a}% leaves no amber band at all — every figure would be red or green.`,
    };
  }
  return null;
}

/** The point the chart is drawn to. Both figures are CUMULATIVE hours at that day. */
export type UtilisationPoint = { soldToDate: number; availableToDate: number } | null;

/**
 * NULL = show no light. Three ways to get there, all of them honest:
 *   • no point (no series, or the elapsed day is not in it)
 *   • available-to-date is zero or negative — nothing was sellable, so nothing was under-sold
 *   • the figures are not finite
 */
export function utilisationLight(
  point: UtilisationPoint,
  thresholds: UtilisationThresholds,
): { colour: UtilisationColour; pct: number } | null {
  if (!point) return null;
  const { soldToDate, availableToDate } = point;
  if (!Number.isFinite(soldToDate) || !Number.isFinite(availableToDate)) return null;
  if (!(availableToDate > 0)) return null;

  const pct = (soldToDate / availableToDate) * 100;
  // Boundaries belong to the band ABOVE: exactly 50% with red-below-50 is amber, not red. "Below"
  // in the setting means below, and a garage landing exactly on its own target is not failing it.
  const colour: UtilisationColour = pct < thresholds.redBelow ? 'red' : pct < thresholds.amberBelow ? 'amber' : 'green';
  return { colour, pct };
}

/** Reads the tenant's stored thresholds, falling back to the defaults per field — a half-configured
 *  row must not produce a half-broken light. */
export const thresholdsFromGroup = (g: { util_red_below?: number | null; util_amber_below?: number | null } | null | undefined): UtilisationThresholds => ({
  redBelow: g?.util_red_below ?? DEFAULT_UTIL_RED_BELOW,
  amberBelow: g?.util_amber_below ?? DEFAULT_UTIL_AMBER_BELOW,
});
