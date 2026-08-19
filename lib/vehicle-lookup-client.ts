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
  | { ok: true; reg: string; source: 'records' | 'dvsa'; vehicle: LookupVehicleFields; owner: LookupOwnerFields | null; mot: LookupMotMeta | null;
      /** Owner's missed bookings, present only on a records hit with history (null = none or unknown). */
      noShows?: { count: number; dates: string[] } | null;
      /** Open due items on this car (null = none, or a non-records hit). */
      dueItems?: Array<{ id: string; description: string; dueBasis: string; dueDate: string | null; dueMileage: number | null; customerResponse: string }> | null }
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
  opts: { internal?: boolean; vehicleId?: string | null } = {},
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
          // Present only on a records hit with a resolved owner — a DVSA hit knows the car, not the
          // customer, and must not imply a clean history it never checked.
          noShows: data.noShows && data.noShows.count > 0 ? { count: Number(data.noShows.count), dates: (data.noShows.dates ?? []).map(S) } : null,
          // Open findings on this car — present only on a records hit (DVSA knows the car, not
          // what we found on it last March).
          dueItems: Array.isArray(data.dueItems) && data.dueItems.length ? data.dueItems : null,
          mot: null,
        };
      }
    }
    // 2) New car → DVSA MOT History (make/model/colour/year/fuel/engine + MOT metadata). Best-effort:
    //    the endpoint always answers 200 with { found } so a lookup failure never blocks the form.
    // vehicleId, when the caller has one, lets the SERVER keep the MOT odometer history it just
    // fetched (lib/odometer). Absent on a first lookup — the car has no record to hang it on yet.
    const vq = opts.vehicleId ? `&vehicleId=${encodeURIComponent(opts.vehicleId)}` : '';
    const sres = await fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(reg)}${vq}`, { cache: 'no-store' });
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

/**
 * VIN → vehicle prefill (US / NHTSA vPIC), the sibling of lookupVehicleByReg and held to the same
 * contract: NON-THROWING, fill-blanks-only at the caller, and honest about what a VIN cannot say
 * (colour, mileage, plate and inspection history come back empty — never invented).
 */
export type VinLookupResult =
  | { ok: true; vin: string; source: 'vpic'; vehicle: LookupVehicleFields; spec: { trim: string; bodyClass: string; cylinders: string; drive: string } }
  | { ok: false; vin: string; reason: 'empty-vin' | 'invalid-vin' | 'not-found' | 'no-provider' | 'error' };

export async function lookupVehicleByVin(rawVin: string): Promise<VinLookupResult> {
  const vin = String(rawVin ?? '').trim().toUpperCase();
  if (!vin) return { ok: false, vin, reason: 'empty-vin' };
  try {
    const r = await fetch(`/api/vin-lookup?vin=${encodeURIComponent(vin)}`);
    if (!r.ok) return { ok: false, vin, reason: 'error' };
    const d = await r.json();
    if (!d?.found) return { ok: false, vin, reason: (d?.reason ?? 'not-found') as VinLookupResult extends { ok: false } ? any : any };
    return {
      ok: true, vin: d.vin ?? vin, source: 'vpic',
      vehicle: {
        make: S(d.vehicle?.make), model: S(d.vehicle?.model), colour: '', year: Snum(d.vehicle?.year),
        fuel: S(d.vehicle?.fuel), engineCc: Snum(d.vehicle?.engineCc), vin: d.vin ?? vin, mileage: '',
      },
      spec: { trim: S(d.spec?.trim), bodyClass: S(d.spec?.bodyClass), cylinders: S(d.spec?.cylinders), drive: S(d.spec?.drive) },
    };
  } catch {
    return { ok: false, vin, reason: 'error' };
  }
}

/**
 * FETCH THE DVSA ODOMETER HISTORY FOR A CAR WE HAVE JUST CREATED.
 *
 * ── THE DEFERRAL THAT NEVER RESOLVED ────────────────────────────────────────────────────────────
 * /api/dvsa-lookup keeps the MOT odometer history only when the caller names a vehicle we own —
 * reasonably, since a first lookup on an unknown reg has nothing to attach it to. Its comment says
 * "the readings land on the next lookup once the record exists".
 *
 * They never did. The only caller that passed a vehicleId was the job card's manual look-up button,
 * which a garage that books through the diary never presses. Measured 2026-08-19 on 221 real cars:
 * ZERO MOT-sourced odometer readings, for any vehicle, ever. Every reading in the database was a
 * mileage typed at a visit, and only 30 of TMBS's 221 cars had the two readings a rate needs.
 * (Both figures are from BEFORE the backfill; after it, 192 of 221 carry a rate.)
 *
 * That is not a small gap. The rate feeds the servicing list's dated band, the tyre wear rate and
 * the battery decline projection — all three were running on 14% of the fleet.
 *
 * So the deferral is resolved HERE, by the creating surface, the moment the vehicle exists.
 *
 * BEST-EFFORT AND FIRE-AND-FORGET: it must never delay or fail a booking. A car with no DVSA
 * history simply stores nothing, which is the same outcome as before.
 */
export function backfillMotHistory(registration: string, vehicleId: string | null | undefined): void {
  if (!registration || !vehicleId) return;
  void fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(registration)}&vehicleId=${encodeURIComponent(vehicleId)}`,
    { cache: 'no-store' }).catch(() => {});
}
