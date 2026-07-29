/**
 * File: pages/api/vin-lookup.ts
 * NHTSA vPIC VIN decode for US tenants (ruling 2026-07-29). GET ?vin=… → form pre-fill fields.
 * Server-side on purpose: one outbound host to reason about, no CORS surprises, and the tenant's
 * country is verified here rather than trusted from the client.
 *
 * vPIC is US DOT, free, no API key. It decodes the MANUFACTURING SPEC — make/model/year/engine/fuel.
 * It does NOT know colour, mileage, plate or inspection history; those come back empty and the form
 * leaves them blank (honest-null: an empty field is "not known", never a zero).
 *
 * NON-THROWING, mirroring lib/vehicle-lookup-client: every failure resolves to { found:false,
 * reason } so the form stays fully usable for manual entry. vPIC answers HTTP 200 even for garbage,
 * so the payload's own ErrorCode is what decides found/not-found.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { isPlausibleVin, lookupProvider } from '@/lib/vehicle-lookup-providers';

const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';
const S = (v: unknown): string => (v == null ? '' : String(v).trim());

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vin = S(req.query.vin).toUpperCase();
  if (!vin) return res.status(200).json({ found: false, reason: 'empty-vin' });
  if (!isPlausibleVin(vin)) return res.status(200).json({ found: false, reason: 'invalid-vin' });

  // The tenant's country decides the provider — a client cannot ask for a decoder it isn't entitled to.
  const group = await prisma.group.findUnique({ where: { id: user.group_id as string }, select: { country_code: true, ref: true } });
  const profile = resolveTenantProfile(group);
  const provider = lookupProvider(profile.vehicleLookupProvider);
  if (!provider || provider.key !== 'vin') return res.status(200).json({ found: false, reason: 'no-provider' });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000); // a slow federal API must never hang the form
    const r = await fetch(`${VPIC}/${encodeURIComponent(vin)}?format=json`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return res.status(200).json({ found: false, reason: 'error' });
    const data = await r.json();
    const row = Array.isArray(data?.Results) ? data.Results[0] : null;
    if (!row) return res.status(200).json({ found: false, reason: 'not-found' });

    // vPIC returns 200 for nonsense — ErrorCode '0' means a clean decode. Codes are comma-joined;
    // treat "0" (and the informational-only "unused position" codes) as decoded, anything else as
    // a miss rather than half-filling a form with guesses.
    const codes = S(row.ErrorCode).split(',').map((c) => c.trim()).filter(Boolean);
    const decoded = codes.length === 0 || codes.every((c) => c === '0');
    const make = S(row.Make), model = S(row.Model), year = S(row.ModelYear);
    if (!decoded && !(make && model)) return res.status(200).json({ found: false, reason: 'not-found', detail: S(row.ErrorText).slice(0, 200) });
    if (!make && !model && !year) return res.status(200).json({ found: false, reason: 'not-found' });

    // Displacement: vPIC gives CC (and litres). Round CC to a whole number for engine_cc.
    const cc = Number(S(row.DisplacementCC));
    return res.status(200).json({
      found: true,
      source: 'vpic',
      vin,
      vehicle: {
        make, model, year,
        engineCc: Number.isFinite(cc) && cc > 0 ? String(Math.round(cc)) : '',
        fuel: S(row.FuelTypePrimary),
        // NOT IN A VIN — left empty on purpose (never invented):
        colour: '', mileage: '',
      },
      // Extra spec vPIC knows but the vehicle record has no column for — surfaced for the UI note
      // only, never written.
      spec: { trim: S(row.Trim), bodyClass: S(row.BodyClass), cylinders: S(row.EngineCylinders), drive: S(row.DriveType) },
    });
  } catch {
    return res.status(200).json({ found: false, reason: 'error' }); // abort/network — manual entry stands
  }
}
