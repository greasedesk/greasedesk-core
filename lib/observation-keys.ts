/**
 * File: lib/observation-keys.ts
 * WHAT A MACHINE-WRITTEN FINDING IS, as a stable key rather than the words it happens to use.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
 * The tyre and battery writers used to find their own open finding by DESCRIPTION PREFIX, so that
 * re-measuring corrected rather than stacked. It worked, and it also matched prose a human had
 * typed: "Battery terminals corroded" was an open finding starting with "Battery", so the next
 * battery test UPDATED IT into a battery advisory. No error, no trace — a genuine observation
 * simply became a different one. The same shape existed for "Rear left brake pad low".
 *
 * A key cannot collide with prose. It also survives a mechanic rewording the description, which a
 * prefix does not, and it is the only thing that can answer "how many of these did we find across
 * the whole book" — a question no amount of string matching can be trusted with.
 *
 * ── ONE OPEN ITEM PER OBSERVATION PER CAR ───────────────────────────────────────────────────────
 * Enforced by a partial unique index, not by the writers being careful. A writer that forgets to
 * update-in-place now fails loudly instead of quietly stacking a near-duplicate.
 *
 * ── THE KEY SPACE IS SHARED ─────────────────────────────────────────────────────────────────────
 * Machine-derived measurements live here now. The tap-observation catalogue will register into the
 * same space, so a wiper blade and a tyre depth are countable side by side and one partial unique
 * index covers both.
 */
import type { TyreCorner } from '@/lib/tyres';

/**
 * A tyre worn out, PER CORNER — four different jobs, four different keys, because a garage sells
 * one tyre at a time.
 */
export const tyreDepthKey = (corner: TyreCorner): string => `tyre_depth_${corner}`;

/**
 * Tread worn across its width. ONE key for the car, NOT one per corner — and that is deliberate,
 * preserving the behaviour the prefix version had. Alignment is a single job on the car; nobody
 * sells four of them, and four open items for one tracking job would read as four things to fix.
 */
export const TYRE_ALIGNMENT_KEY = 'tyre_alignment';

/** The battery test. One battery, one key. */
export const BATTERY_KEY = 'battery';

/**
 * Every key a machine writer may use. A caller passing something not in here is a bug, and the
 * check below is what turns that into a refusal rather than an unmatchable row.
 *
 * NOT exhaustive of the key SPACE — the tap-observation catalogue adds its own and registers here.
 */
export const MACHINE_OBSERVATION_KEYS: ReadonlySet<string> = new Set<string>([
  'tyre_depth_front_left', 'tyre_depth_front_right', 'tyre_depth_rear_left', 'tyre_depth_rear_right',
  TYRE_ALIGNMENT_KEY,
  BATTERY_KEY,
]);

export const isMachineObservationKey = (k: string): boolean => MACHINE_OBSERVATION_KEYS.has(k);
