/**
 * File: lib/timezone-choices.ts
 * THE one derivation of "which timezones may this tenant pick, and how do they read" — shared by
 * onboarding Step 2 and Settings (Financial + per-site Locations), so the two can never drift.
 *
 * Rules (rulings 2026-07-28/29):
 *   • Options come from the COUNTRY PROFILE; a US state NARROWS them (lib/us-states) — never widens.
 *   • US zones display by NAME ("Central Time", Phoenix = "Mountain Time (no DST)"); everywhere
 *     else by city ("London", "Dublin") — labels only, the stored IANA value is untouched.
 *   • One option = nothing to pick → render as set (fixed), same treatment as currency.
 */
import type { CountryProfile } from '@/lib/locale-profiles';
import { getUsState, usZoneLabel } from '@/lib/us-states';

export type ZoneOption = { value: string; label: string };
export type ZoneChoices = { options: ZoneOption[]; fixed: boolean };

const cityLabel = (z: string) => (z.split('/').pop() ?? z).replace(/_/g, ' ');

export function zoneChoicesFor(profile: CountryProfile, stateCode?: string | null): ZoneChoices {
  const state = profile.stateField === true ? getUsState(stateCode) : null;
  const zones = state ? state.zones : profile.timezones;
  const options = zones.map((z) => ({
    value: z,
    label: profile.stateField === true ? usZoneLabel(z) : cityLabel(z),
  }));
  return { options, fixed: options.length === 1 };
}

/** The zone to preselect: the stored value when it's a legal option, else the first (majority/default). */
export function initialZone(choices: ZoneChoices, stored: string | null | undefined): string {
  return stored && choices.options.some((o) => o.value === stored) ? stored : choices.options[0].value;
}

/** Server-side write validation: a submitted zone must be one of the PROFILE's zones (the state
 *  narrows the UI, not the API — same stance as onboarding update-rates). */
export function isZoneAllowed(profile: CountryProfile, zone: string): boolean {
  return profile.timezones.includes(zone);
}
