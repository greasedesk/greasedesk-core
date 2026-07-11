/**
 * File: lib/leave-types.ts
 * THE leave-type registry: the seven types, the allowance rule, and the colour defaults.
 * Isomorphic (no prisma) — the Roster page imports it too.
 *
 * ALLOWANCE RULE (binding, single source — never scatter type conditionals):
 * only `annual` + `closure` consume the annual-leave grant. sick / compassionate / parental /
 * training / other are CAPACITY-AFFECTING but ALLOWANCE-NEUTRAL — they subtract available hours
 * in getAvailableHours (which reads ALL leave rows, type-blind, by design) yet never move the
 * "N taken · M left" balance line. Per-type caps (e.g. 10 sick days/yr) are banked.
 */
export const LEAVE_TYPES = ['annual', 'sick', 'compassionate', 'parental', 'training', 'other', 'closure'] as const;
export type LeaveTypeKey = typeof LEAVE_TYPES[number];

export const DEDUCTS_ALLOWANCE: Record<LeaveTypeKey, boolean> = {
  annual: true,
  closure: true, // company shutdown consumes the grant BY DESIGN (allowance = full grant model)
  sick: false,
  compassionate: false,
  parental: false,
  training: false,
  other: false,
};

// Default colours = the Okabe–Ito colour-blind-safe palette (distinguishable under the common
// dichromacies). Admin-remappable per tenant via Group.leave_type_colours (accessibility: a
// colour-blind user must be able to remap) — these are DEFAULTS, not constants baked into UI.
export const DEFAULT_LEAVE_COLOURS: Record<LeaveTypeKey, string> = {
  annual: '#0072B2',        // blue
  sick: '#E69F00',          // orange
  compassionate: '#009E73', // bluish green
  parental: '#56B4E9',      // sky blue
  training: '#D55E00',      // vermillion
  other: '#999999',         // grey
  closure: '#CC79A7',       // reddish purple
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Tenant colour map: defaults overlaid with the group's valid overrides (unknown keys and
 *  malformed values ignored — pre-configuration nothing breaks). */
export function resolveLeaveColours(cfg: unknown): Record<LeaveTypeKey, string> {
  const out = { ...DEFAULT_LEAVE_COLOURS };
  if (cfg && typeof cfg === 'object') {
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if ((LEAVE_TYPES as readonly string[]).includes(k) && typeof v === 'string' && HEX.test(v)) {
        out[k as LeaveTypeKey] = v;
      }
    }
  }
  return out;
}
