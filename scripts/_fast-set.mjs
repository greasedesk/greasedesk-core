/**
 * File: scripts/_fast-set.mjs
 * THE FAST SET — derived from measured times, never declared as a list.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * The rerun policy (owner, 2026-09-17): while building, run the slice's own gates plus the FAST SET;
 * all three tiers before every commit. The first time it was used, the fast set was "every gate under
 * 2 seconds in this run", picked by hand — an undeclared list. It works once and drifts at once: a gate
 * that slows down silently stays in it, and a new fast gate never joins.
 *
 * ── WHY DERIVED AND NOT DECLARED ────────────────────────────────────────────────────────────────
 * A declared list needs a gate that keeps it equal to the measurements, in both directions — which is
 * this derivation plus a hand edit every time membership changes. A list kept equal to a measurement is
 * a second copy of the measurement. So membership IS the measurement, and the runner prints the basis.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────────────
 *  · ONLY A GREEN RUN IS A MEASUREMENT. A gate that throws or fails early looks fast; a crashed browser
 *    gate would otherwise join the set. A red, a timeout or a decline leaves the last measurement alone.
 *  · THE LATEST GREEN RUN DECIDES. A gate that has slowed down leaves the set on its next green run.
 *  · AN UNMEASURED GATE IS IN THE SET. A new gate has not shown it is slow; leaving it out is the
 *    never-joins failure. It runs once, is measured, and settles where its time puts it.
 *  · THE MANUAL TIER IS NEVER IN IT, measured or not — those gates run on purpose (demo generation).
 *
 * ── THE WEAKNESS, ACCEPTED ──────────────────────────────────────────────────────────────────────
 * Membership moves with the machine: on a slow database day a borderline gate drops out. It still runs
 * in its tier before every commit, so nothing goes untested — the set is smaller that day, and the printed
 * basis says why.
 *
 * No side effects: the runner reads and writes the timings file; fast-set-gate drives these functions.
 */

/**
 * THE THRESHOLD. A JUDGEMENT, and it should look like one: two seconds is where the source scans, pure
 * gates and database-only gates sat on 2026-09-17, and where the browser gates began. Named here, once.
 * Strictly under: a gate measured at exactly the threshold is not fast.
 */
export const FAST_THRESHOLD_S = 2;

/** The tier that is never in the fast set. */
export const NEVER_FAST_TIER = 'manual';

/** Is this run a measurement? Green, finished, and not a decline. */
export const isMeasurement = (res) => res.code === 0 && !res.timedOut && !res.unrun;

/**
 * RECORD a run into the timings map. Returns a NEW map; a run that is not a measurement returns the map
 * unchanged, so an earlier green measurement survives a later red.
 */
export function recordTiming(timings, res, now = new Date()) {
  if (!isMeasurement(res)) return timings;
  return { ...timings, [res.gate]: { seconds: res.seconds, measuredAt: now.toISOString() } };
}

/** The basis for one gate, as the runner prints it. */
export function basisFor(m) {
  if (!m) return 'unmeasured';
  return `${m.seconds}s, measured ${m.measuredAt.slice(0, 10)}`;
}

/**
 * THE SET. Every gate, with whether it is in and why — the caller filters on `member`, and prints all of
 * it, so a gate's absence is as visible as its presence.
 */
export function fastSet(gates, timings, tierOf, threshold = FAST_THRESHOLD_S) {
  return gates.map((gate) => {
    const tier = tierOf(gate);
    const m = timings[gate] ?? null;
    if (tier === NEVER_FAST_TIER) return { gate, tier, member: false, basis: `${basisFor(m)} — ${NEVER_FAST_TIER} tier, never in the fast set` };
    if (!m) return { gate, tier, member: true, basis: 'unmeasured — in the set until a green run says otherwise' };
    return { gate, tier, member: m.seconds < threshold, basis: basisFor(m) };
  });
}
