/**
 * File: lib/dvla.ts
 * THE one place the DVLA Vehicle Enquiry Service (VES) is called — SERVER-SIDE ONLY (the api key never
 * reaches the client). Free VES returns make, colour, fuelType, engineCapacity (cc), yearOfManufacture,
 * CO2, MOT/tax status — but NOT model. Best-effort: any failure (no key configured, unknown/foreign
 * plate → 404, bad key → 403, API down, timeout) returns null so the caller falls back to manual entry
 * and NEVER blocks a booking.
 *
 * Config (env): DVLA_VES_API_KEY (required to activate), DVLA_VES_URL (optional — defaults to live;
 * point at the UAT host to test).
 */
export type DvlaVehicle = { make?: string; colour?: string; fuel?: string; year?: number; engineCc?: number };

const LIVE_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';

export function dvlaConfigured(): boolean {
  return !!process.env.DVLA_VES_API_KEY;
}

export async function dvlaLookup(registration: string): Promise<DvlaVehicle | null> {
  const key = process.env.DVLA_VES_API_KEY;
  const reg = (registration || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key || !reg) return null; // not configured, or nothing to look up → graceful no-op

  const url = process.env.DVLA_VES_URL || LIVE_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000); // never hang a booking on DVLA
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ registrationNumber: reg }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null; // 404 unknown plate / 400 bad reg / 403 bad key / 5xx → manual
    const d = (await res.json()) as any;
    const num = (v: any) => (Number.isFinite(Number(v)) && Number.isInteger(Number(v)) ? Number(v) : undefined);
    return {
      make: d.make ? String(d.make) : undefined,
      colour: d.colour ? String(d.colour) : undefined,
      fuel: d.fuelType ? String(d.fuelType) : undefined,
      year: num(d.yearOfManufacture),
      engineCc: num(d.engineCapacity),
    };
  } catch {
    return null; // network error / abort / bad JSON → manual
  } finally {
    clearTimeout(timer);
  }
}
