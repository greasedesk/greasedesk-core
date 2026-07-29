/**
 * File: lib/us-states.ts
 * THE canonical US state list (50 + DC) with timezone derivation. Consumed by the onboarding site
 * step (state select) and the rates step (zone derivation). Every zone here is one of the US
 * country profile's zones — state NARROWS within the profile set, it never widens beyond it, and
 * `update-rates` still validates against the profile, so this file can never smuggle in a zone.
 *
 * SPLIT STATES: `zones` lists every zone the state genuinely spans, MAJORITY FIRST — the picker
 * preselects zones[0] so the default is right for most garages and correctable for the rest.
 * Verified split set (12): TN, KY, FL, TX, IN, KS, NE, MI, ND, SD, ID, OR.
 *
 * DELIBERATE SIMPLIFICATIONS (documented, not bugs):
 *   • AZ → America/Phoenix single (the Navajo Nation observes DST but has no distinct IANA zone
 *     we offer; Phoenix is correct for effectively every garage).
 *   • NV → Pacific single (West Wendover's Mountain sliver is negligible).
 *   • AK → America/Anchorage single (the Aleutian America/Adak sliver is not offered by the
 *     profile; Anchorage covers effectively the whole state).
 */

export type UsState = {
  code: string;   // USPS two-letter
  name: string;
  zones: string[]; // IANA zones the state spans — MAJORITY FIRST; length 1 = unambiguous
};

const NY = 'America/New_York';
const CH = 'America/Chicago';
const DE = 'America/Denver';
const PH = 'America/Phoenix';
const LA = 'America/Los_Angeles';
const AK = 'America/Anchorage';
const HI = 'Pacific/Honolulu';

export const US_STATES: UsState[] = [
  { code: 'AL', name: 'Alabama', zones: [CH] },
  { code: 'AK', name: 'Alaska', zones: [AK] },
  { code: 'AZ', name: 'Arizona', zones: [PH] },
  { code: 'AR', name: 'Arkansas', zones: [CH] },
  { code: 'CA', name: 'California', zones: [LA] },
  { code: 'CO', name: 'Colorado', zones: [DE] },
  { code: 'CT', name: 'Connecticut', zones: [NY] },
  { code: 'DE', name: 'Delaware', zones: [NY] },
  { code: 'DC', name: 'District of Columbia', zones: [NY] },
  { code: 'FL', name: 'Florida', zones: [NY, CH] },       // split: panhandle west of the Apalachicola is Central
  { code: 'GA', name: 'Georgia', zones: [NY] },
  { code: 'HI', name: 'Hawaii', zones: [HI] },
  { code: 'ID', name: 'Idaho', zones: [DE, LA] },         // split: northern panhandle is Pacific
  { code: 'IL', name: 'Illinois', zones: [CH] },
  { code: 'IN', name: 'Indiana', zones: [NY, CH] },       // split: NW (Gary) + SW (Evansville) corners are Central
  { code: 'IA', name: 'Iowa', zones: [CH] },
  { code: 'KS', name: 'Kansas', zones: [CH, DE] },        // split: four western counties are Mountain
  { code: 'KY', name: 'Kentucky', zones: [NY, CH] },      // split: western half is Central
  { code: 'LA', name: 'Louisiana', zones: [CH] },
  { code: 'ME', name: 'Maine', zones: [NY] },
  { code: 'MD', name: 'Maryland', zones: [NY] },
  { code: 'MA', name: 'Massachusetts', zones: [NY] },
  { code: 'MI', name: 'Michigan', zones: [NY, CH] },      // split: four western UP counties are Central
  { code: 'MN', name: 'Minnesota', zones: [CH] },
  { code: 'MS', name: 'Mississippi', zones: [CH] },
  { code: 'MO', name: 'Missouri', zones: [CH] },
  { code: 'MT', name: 'Montana', zones: [DE] },
  { code: 'NE', name: 'Nebraska', zones: [CH, DE] },      // split: western panhandle is Mountain
  { code: 'NV', name: 'Nevada', zones: [LA] },
  { code: 'NH', name: 'New Hampshire', zones: [NY] },
  { code: 'NJ', name: 'New Jersey', zones: [NY] },
  { code: 'NM', name: 'New Mexico', zones: [DE] },
  { code: 'NY', name: 'New York', zones: [NY] },
  { code: 'NC', name: 'North Carolina', zones: [NY] },
  { code: 'ND', name: 'North Dakota', zones: [CH, DE] },  // split: southwest is Mountain
  { code: 'OH', name: 'Ohio', zones: [NY] },
  { code: 'OK', name: 'Oklahoma', zones: [CH] },
  { code: 'OR', name: 'Oregon', zones: [LA, DE] },        // split: most of Malheur County is Mountain
  { code: 'PA', name: 'Pennsylvania', zones: [NY] },
  { code: 'RI', name: 'Rhode Island', zones: [NY] },
  { code: 'SC', name: 'South Carolina', zones: [NY] },
  { code: 'SD', name: 'South Dakota', zones: [CH, DE] },  // split: western half (Rapid City) is Mountain
  { code: 'TN', name: 'Tennessee', zones: [CH, NY] },     // split: east (Knoxville/Chattanooga) is Eastern
  { code: 'TX', name: 'Texas', zones: [CH, DE] },         // split: El Paso corner is Mountain
  { code: 'UT', name: 'Utah', zones: [DE] },
  { code: 'VT', name: 'Vermont', zones: [NY] },
  { code: 'VA', name: 'Virginia', zones: [NY] },
  { code: 'WA', name: 'Washington', zones: [LA] },
  { code: 'WV', name: 'West Virginia', zones: [NY] },
  { code: 'WI', name: 'Wisconsin', zones: [CH] },
  { code: 'WY', name: 'Wyoming', zones: [DE] },
];

/**
 * DISPLAY labels for the US zones (ruling 2026-07-28): Americans refer to zones by NAME, not city.
 * Labels only — the STORED value stays the IANA id exactly (America/Chicago carries the DST rules).
 * Phoenix gets the no-DST note: it is the one case where two entries would otherwise read
 * identically ("Mountain Time") for different clock behaviour.
 */
export const US_ZONE_LABELS: Record<string, string> = {
  'America/New_York': 'Eastern Time',
  'America/Chicago': 'Central Time',
  'America/Denver': 'Mountain Time',
  'America/Phoenix': 'Mountain Time (no DST)',
  'America/Los_Angeles': 'Pacific Time',
  'America/Anchorage': 'Alaska Time',
  'Pacific/Honolulu': 'Hawaii Time',
};

export const usZoneLabel = (zone: string): string => US_ZONE_LABELS[zone] ?? zone;

const byCode = new Map(US_STATES.map((s) => [s.code, s]));

export const isUsStateCode = (code: string | null | undefined): boolean =>
  !!code && byCode.has(code.toUpperCase());

export function getUsState(code: string | null | undefined): UsState | null {
  return code ? byCode.get(code.toUpperCase()) ?? null : null;
}

/** The zone the site step stores at creation: the state's only zone, or the majority zone. */
export function timezoneForState(code: string | null | undefined): string | null {
  return getUsState(code)?.zones[0] ?? null;
}
