/**
 * File: lib/observations.ts
 * QUICK OBSERVATIONS — the third capture shape, and the one that fills a workshop.
 *
 * Tyres and battery are MEASUREMENTS: numbers, thresholds, a rule that decides what they mean.
 * These are OBSERVATIONS: a mechanic notices, taps, done. No numbers, no thresholds. They matter
 * commercially because they are the cheap jobs — a wiper blade is £15 and never gets sold, because
 * writing four words costs more attention than the sale is worth at the moment it is noticed.
 *
 * ── THE RULE: DESCRIBE WHAT WAS SEEN, NEVER NAME THE CAUSE ──────────────────────────────────────
 * "Clutch biting point is high", never "clutch worn". "Wiper blades smearing", never "wipers
 * faulty". This is a STATED DISCIPLINE, not a stylistic preference, and scripts/observations-gate
 * enforces it against every description in this file.
 *
 * Three reasons it is load-bearing:
 *   · The mechanic can be wrong. A high biting point is usually wear and is sometimes hydraulic.
 *   · A finding that names a part commits the garage to a diagnosis nobody has made, in writing,
 *     on a document the customer keeps.
 *   · The customer report carries no prices, so a "yes" means QUOTE ME. Naming the part pre-empts
 *     the quote that is supposed to follow.
 *
 * The boundary is worth stating precisely, because lib/battery DOES say "replace": a MEASUREMENT
 * earns the right to advise, because there is a number behind it and a threshold it crossed. An
 * observation has neither. Someone noticing a thing is not the same as a tester reporting one.
 *
 * ── THE BASIS IS AUTHORED PER ENTRY. IT IS NOT A DEFAULT. ───────────────────────────────────────
 * Every entry states its own `basis`, and today every one of them says `next_service`. That looks
 * exactly like a default and is not: the field is required on the type, so adding an observation
 * forces whoever adds it to decide, and an entry that genuinely belongs on a clock can say so
 * without anyone unpicking a global assumption. The distinction matters because the ANSWER is
 * deliberately NOT defaulted anywhere (see below) and the two must not be confused for each other.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────────
 * The customer's response. It has no default on any surface, because a mechanic tapping through at
 * speed would record every finding as `not_raised`, and `declined` — the only response that is a
 * lead — would never appear. Speed is the point of this file and it stops exactly there.
 *
 * ── FIXED IN CODE, ON PURPOSE ───────────────────────────────────────────────────────────────────
 * Not per-tenant. The moment garages author their own labels the aggregate question dies: "how many
 * wiper blades did the book spot and never sell" needs one key meaning one thing everywhere. The
 * cost of that decision is paid back by "Other", which falls through to the free-text form and
 * turns every unlisted finding into a vote for what to promote here next.
 */

/** Today every entry is `next_service`. The type is a union so a future clock-bound observation
 *  states its own rather than inheriting a decision nobody made. */
export type ObservationBasis = 'next_service';

/** A parent tap that expands rather than saving. Bulbs are the only one, and see BULBS below. */
export type ObservationGroup = 'bulb';

export type Observation = {
  key: string;
  /** What the mechanic taps. Short — it has to be readable at arm's length on a 390px screen. */
  label: string;
  /** What lands on the finding, and therefore on the customer report and the invoice block. */
  description: string;
  basis: ObservationBasis;
  /** Members of a two-step group are hidden from the top level and reached through their parent. */
  group?: ObservationGroup;
};

/**
 * BULBS: EIGHT COMBINATIONS, NOT SIXTEEN CELLS.
 *
 * Nearside/offside × front/rear × headlight/sidelight/indicator/brake is a cross-product imagined
 * from the axes rather than read off a job sheet. A mechanic writes "n/s headlight out" — one
 * label, not three coordinates. Eight real combinations in two columns is one tap and no reading;
 * a sixteen-cell grid is a visual search. Anything genuinely missing falls through to "Other" and
 * votes for itself.
 */
export const BULB_GROUP_LABEL = 'Bulb out';

/**
 * The catalogue, in COLD-START ORDER — roughly how often a garage meets each one, so a tenant with
 * no history of their own still gets a sensible list on day one. After that lib/observations'
 * ordering puts their own most-used first (see orderObservations).
 */
export const OBSERVATIONS: readonly Observation[] = [
  { key: 'wipers_smearing', label: 'Wipers smearing', description: 'Wiper blades smearing', basis: 'next_service' },
  { key: 'screenwash_empty', label: 'Screenwash empty', description: 'Screenwash empty', basis: 'next_service' },
  { key: 'tyre_pressures_low', label: 'Pressures low', description: 'Tyre pressures low', basis: 'next_service' },
  { key: 'air_filter_dirty', label: 'Air filter dirty', description: 'Air filter dirty', basis: 'next_service' },
  { key: 'pollen_filter_dirty', label: 'Pollen filter dirty', description: 'Pollen filter dirty', basis: 'next_service' },
  { key: 'wipers_split', label: 'Wiper split', description: 'Wiper blade split', basis: 'next_service' },
  { key: 'brake_fluid_discoloured', label: 'Brake fluid dark', description: 'Brake fluid is discoloured', basis: 'next_service' },
  { key: 'coolant_low', label: 'Coolant low', description: 'Coolant below the minimum mark', basis: 'next_service' },
  { key: 'aux_belt_squealing', label: 'Belt squealing', description: 'Auxiliary belt squealing', basis: 'next_service' },
  // TWO KEYS, NOT ONE WITH A VALUE. A high biting point usually leads to a clutch replacement and a
  // low one often to hydraulics — a master cylinder, a slave, or air in the line. Different jobs at
  // very different money, so one shared key would make the count meaningless by mixing them.
  { key: 'clutch_biting_high', label: 'Biting point high', description: 'Clutch biting point is high', basis: 'next_service' },
  { key: 'clutch_biting_low', label: 'Biting point low', description: 'Clutch biting point is low', basis: 'next_service' },
  { key: 'exhaust_blowing', label: 'Exhaust blowing', description: 'Exhaust blowing', basis: 'next_service' },
  { key: 'number_plate_faded', label: 'Number plate faded', description: 'Number plate faded or cracked', basis: 'next_service' },
  { key: 'handbrake_travel', label: 'Handbrake travel', description: 'Handbrake travel is excessive', basis: 'next_service' },
  { key: 'suspension_knock', label: 'Suspension knock', description: 'Knock from the suspension', basis: 'next_service' },
  { key: 'oil_leak_engine', label: 'Oil leak, engine', description: 'Oil leak from the engine', basis: 'next_service' },
  { key: 'oil_leak_gearbox', label: 'Oil leak, gearbox', description: 'Oil leak from the gearbox', basis: 'next_service' },

  // ── THE BULB GROUP ────────────────────────────────────────────────────────────────────────────
  { key: 'bulb_ns_headlight', label: 'N/S headlight', description: 'N/S headlight not working', basis: 'next_service', group: 'bulb' },
  { key: 'bulb_os_headlight', label: 'O/S headlight', description: 'O/S headlight not working', basis: 'next_service', group: 'bulb' },
  { key: 'bulb_ns_front_indicator', label: 'N/S front indicator', description: 'N/S front indicator not working', basis: 'next_service', group: 'bulb' },
  { key: 'bulb_os_front_indicator', label: 'O/S front indicator', description: 'O/S front indicator not working', basis: 'next_service', group: 'bulb' },
  { key: 'bulb_ns_rear_light', label: 'N/S rear light', description: 'N/S rear light not working', basis: 'next_service', group: 'bulb' },
  { key: 'bulb_os_rear_light', label: 'O/S rear light', description: 'O/S rear light not working', basis: 'next_service', group: 'bulb' },
  { key: 'bulb_brake_light', label: 'Brake light', description: 'Brake light not working', basis: 'next_service', group: 'bulb' },
  { key: 'bulb_number_plate', label: 'Number plate light', description: 'Number plate light not working', basis: 'next_service', group: 'bulb' },
];

const BY_KEY: ReadonlyMap<string, Observation> = new Map(OBSERVATIONS.map((o) => [o.key, o]));
export const observationByKey = (key: string): Observation | null => BY_KEY.get(key) ?? null;
export const OBSERVATION_KEYS: ReadonlySet<string> = new Set(OBSERVATIONS.map((o) => o.key));

/** The ones that appear at the top level — group members are reached through their parent. */
export const TOP_LEVEL: readonly Observation[] = OBSERVATIONS.filter((o) => !o.group);
export const bulbMembers = (): readonly Observation[] => OBSERVATIONS.filter((o) => o.group === 'bulb');

/** How many float above the "More" line. Six is what fits above the fold at 390px without scroll. */
export const VISIBLE_BEFORE_MORE = 6;

/**
 * THIS TENANT'S OWN LIST, MOST-USED FIRST.
 *
 * ── WHY THIS IS NOT A REFINEMENT ────────────────────────────────────────────────────────────────
 * Seventeen chips in a flat list is a VISUAL SEARCH, and a visual search on a phone at a car is
 * slower than typing four words. Without ordering, the feature is worse than the thing it replaces.
 * So the ordering ships with it.
 *
 * Derived from the garage's own history — no settings screen, nothing to configure, and it tunes
 * itself as their work changes. Ties keep the cold-start order, so a tenant with no history at all
 * still gets a sensible list rather than an alphabetical one.
 *
 * PURE, so the ordering is provable without a database.
 */
export function orderObservations(counts: Readonly<Record<string, number>>): Observation[] {
  const rank = new Map(TOP_LEVEL.map((o, i) => [o.key, i]));
  return [...TOP_LEVEL].sort((a, b) => {
    const d = (counts[b.key] ?? 0) - (counts[a.key] ?? 0);
    // Ties fall back to the authored order. Array.prototype.sort has been stable since ES2019, so
    // this line is not what makes that true — removing it changes nothing, which is exactly what a
    // probe found when the gate stayed green without it. It is kept because the ordering rule
    // should be readable in the comparator rather than inferred from a platform guarantee, and the
    // gate pins the OUTCOME, which is then guaranteed twice over.
    return d !== 0 ? d : (rank.get(a.key) as number) - (rank.get(b.key) as number);
  });
}

/**
 * The bulb parent's own usage, so a garage that changes a lot of bulbs sees the group rise with
 * everything else rather than being pinned wherever it was authored.
 */
export const bulbUsage = (counts: Readonly<Record<string, number>>): number =>
  bulbMembers().reduce((n, o) => n + (counts[o.key] ?? 0), 0);

/**
 * WHERE THE BULB GROUP SITS BEFORE A GARAGE HAS ANY HISTORY.
 *
 * It needs an authored rank exactly as every entry does, and the first version had none: with all
 * counts at zero the group sorted below everything and landed at position eighteen, behind "More"
 * — one of the commonest observations in a workshop, hidden on day one. Second, because a blown
 * bulb is close to the most frequent thing anybody taps.
 */
export const BULB_COLD_START_INDEX = 1;

/** The sentinel for the bulb parent in a tap list. Not an Observation: it saves nothing. */
export const BULB_TAP = { group: 'bulb' } as const;
export type TapEntry = Observation | typeof BULB_TAP;
export const isBulbTap = (e: TapEntry): e is typeof BULB_TAP => 'group' in e && !('key' in e);

/**
 * THE LIST A SURFACE ACTUALLY RENDERS — observations and the bulb parent, in one order.
 *
 * Here rather than in the components, because it was written twice (desktop and phone) and two
 * copies of an ordering rule is two chances to disagree about what a mechanic sees. Pure, so the
 * placement is provable without rendering anything.
 */
export function orderedTapList(counts: Readonly<Record<string, number>>): TapEntry[] {
  const ordered = orderObservations(counts);
  const bulbs = bulbUsage(counts);
  // With real usage the group is ranked like anything else: it goes above the first entry the
  // garage has used less often. With no usage at all nothing is "less often", so the authored
  // cold-start position is what places it.
  const at = bulbs > 0
    ? ordered.findIndex((o) => (counts[o.key] ?? 0) < bulbs)
    : BULB_COLD_START_INDEX;
  const list: TapEntry[] = [...ordered];
  list.splice(at === -1 ? ordered.length : at, 0, BULB_TAP);
  return list;
}
