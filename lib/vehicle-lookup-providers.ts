/**
 * File: lib/vehicle-lookup-providers.ts
 * THE vehicle-lookup provider registry (ruling 2026-07-29) — same shape as the setup-wizard handler
 * registry: the COUNTRY PROFILE names a provider, this file binds that name to behaviour. Adding a
 * country is a profile entry plus (at most) one handler here; an unknown provider FAILS CLOSED to
 * no-lookup rather than guessing.
 *
 * The structural fact: providers are keyed on DIFFERENT fields. GB's DVSA MOT History is keyed on
 * the REGISTRATION; the US NHTSA vPIC decoder is keyed on the VIN. So the lookup control belongs
 * against a different input per country — layout, not just a hidden button.
 *
 * vPIC decodes the MANUFACTURING SPECIFICATION, not the individual car: make/model/year/engine/fuel
 * yes; colour, mileage, plate and inspection history NO — those stay honestly empty for US tenants
 * (they are DVSA-only or simply not in a VIN).
 */
export type LookupProviderName = 'dvsa' | 'vpic' | 'none';
export type LookupKey = 'registration' | 'vin';

export type LookupProvider = {
  /** Which vehicle field the lookup is keyed on — decides where the button renders. */
  key: LookupKey;
  /** Fields this provider can fill, for honest UI copy. */
  fills: string[];
  /** Fields it can NEVER fill (permanently manual for this country). */
  neverFills: string[];
};

export const LOOKUP_PROVIDERS: Record<Exclude<LookupProviderName, 'none'>, LookupProvider> = {
  dvsa: {
    key: 'registration',
    fills: ['make', 'model', 'colour', 'year', 'fuel', 'engineCc', 'motExpiry'],
    neverFills: ['mileage'],
  },
  vpic: {
    key: 'vin',
    fills: ['make', 'model', 'year', 'fuel', 'engineCc'],
    // A VIN carries the build spec only — the individual car's colour, mileage, plate and
    // inspection history are not in it and must never be invented.
    neverFills: ['colour', 'mileage', 'registration', 'motExpiry'],
  },
};

export const lookupProvider = (name: string | null | undefined): LookupProvider | null =>
  name && name !== 'none' && name in LOOKUP_PROVIDERS ? LOOKUP_PROVIDERS[name as Exclude<LookupProviderName, 'none'>] : null;

/** Which field the lookup button sits against, or null when the country has no provider. */
export const lookupKeyFor = (name: string | null | undefined): LookupKey | null => lookupProvider(name)?.key ?? null;

/** VIN shape check — 17 chars, no I/O/Q (the standard exclusion). Cheap client-side reject. */
export const isPlausibleVin = (raw: string): boolean => /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(raw ?? '').trim());
