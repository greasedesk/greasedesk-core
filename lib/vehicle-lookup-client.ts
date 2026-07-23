/**
 * File: lib/vehicle-lookup-client.ts
 * THE one client path for "reg → vehicle prefill", shared by every surface that offers a Look-up
 * button (New Job Card, diary quick-create, existing-card Customer Details). Previously each surface
 * hand-rolled its own fetch→map→setState and they had DRIFTED (one fired on blur and overwrote typed
 * values). This centralises the fetch + normalisation so there is a single implementation to reason
 * about.
 *
 * Order: OUR records first (/api/vehicle-lookup — a returning car brings owner + full vehicle), then
 * DVSA MOT History (/api/dvsa-lookup) for a new car. Best-effort and NON-THROWING: any network/API
 * failure resolves to { ok:false, reason } so the form stays fully usable for manual entry.
 *
 * It deliberately does NOT touch form state. Each caller applies the returned fields FILL-BLANKS-ONLY
 * against its own inputs — the merge policy lives with the form, which alone knows what the user has
 * already typed, and a manual correction must never be clobbered by pressing Look up again.
 */
import { normalizeReg } from '@/lib/vehicle-identity';

export type LookupVehicleFields = {
  make: string; model: string; colour: string; year: string; fuel: string; engineCc: string;
  vin: string; mileage: string;
};
export type LookupOwnerFields = { name: string; phone: string; email: string };
export type LookupMotMeta = { motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null };

export type VehicleLookupResult =
  | { ok: true; reg: string; source: 'records' | 'dvsa'; vehicle: LookupVehicleFields; owner: LookupOwnerFields | null; mot: LookupMotMeta | null }
  | { ok: false; reg: string; reason: 'empty-reg' | 'not-found' | 'error' };

const S = (v: unknown): string => (v == null ? '' : String(v));
const Snum = (v: unknown): string => (v == null ? '' : String(v));

/**
 * Look a registration up for form pre-fill.
 * @param rawReg   the raw reg as typed; canonicalised internally (the returned `reg` is normalised).
 * @param opts.internal  default true — check OUR records first. Pass false where the record already
 *                       exists (the existing-card details form) so only DVSA is consulted.
 */
export async function lookupVehicleByReg(
  rawReg: string,
  opts: { internal?: boolean } = {},
): Promise<VehicleLookupResult> {
  const reg = normalizeReg(rawReg) || '';
  if (!reg) return { ok: false, reg: '', reason: 'empty-reg' };
  const includeInternal = opts.internal !== false;
  try {
    // 1) OUR records — returning car → owner + full vehicle (incl. VIN/mileage).
    if (includeInternal) {
      const res = await fetch(`/api/vehicle-lookup?reg=${encodeURIComponent(reg)}`, { cache: 'no-store' });
      const data = res.ok ? await res.json() : { found: false };
      if (data?.found) {
        const v = data.vehicle || {}, o = data.owner || {};
        return {
          ok: true, reg, source: 'records',
          vehicle: {
            make: S(v.make), model: S(v.model), colour: S(v.colour), year: Snum(v.year),
            fuel: S(v.fuel), engineCc: Snum(v.engineCc), vin: S(v.vin), mileage: Snum(v.mileage),
          },
          owner: { name: S(o.name), phone: S(o.phone), email: S(o.email) },
          mot: null,
        };
      }
    }
    // 2) New car → DVSA MOT History (make/model/colour/year/fuel/engine + MOT metadata). Best-effort:
    //    the endpoint always answers 200 with { found } so a lookup failure never blocks the form.
    const sres = await fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(reg)}`, { cache: 'no-store' });
    const d = sres.ok ? await sres.json() : { found: false };
    if (d?.found) {
      return {
        ok: true, reg, source: 'dvsa',
        vehicle: {
          make: S(d.make), model: S(d.model), colour: S(d.colour), year: Snum(d.year),
          fuel: S(d.fuel), engineCc: Snum(d.engineCc), vin: '', mileage: '',
        },
        owner: null,
        mot: { motExpiry: d.motExpiry ?? null, lastMotMileage: d.lastMotMileage ?? null, lastMotDate: d.lastMotDate ?? null },
      };
    }
    return { ok: false, reg, reason: 'not-found' };
  } catch {
    return { ok: false, reg, reason: 'error' }; // network/parse failure — caller shows "enter manually"
  }
}
