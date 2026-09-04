/**
 * File: pages/api/dvsa-lookup.ts
 * Reg → DVSA MOT History vehicle data for the quick-create pre-fill (NEW cars only; the client calls
 * this after the internal vehicle-lookup misses). GET ?reg=. Server-side only — OAuth token + api key
 * live in lib/dvsa, never the client. Best-effort: always 200 with { found } so a lookup failure never
 * blocks the form. Authenticated (so the credentials aren't a public endpoint).
 */
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { recordOdometerReadings } from '@/lib/odometer';
import { sameRegistration } from '@/lib/vehicle-identity';
import type { NextApiRequest, NextApiResponse } from 'next';
import { normalizeReg } from '@/lib/vehicle-identity';
import { dvsaLookup } from '@/lib/dvsa';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // NEVER cache — this fetches fresh external data. Prevents the browser/Next ETag 304 that would
  // short-circuit the DVSA call. Every lookup must actually execute.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id) return res.status(401).json({ message: 'Not authenticated.' });

  const reg = normalizeReg(req.query.reg as string);
  if (!reg) return res.status(200).json({ found: false });

  const data = await dvsaLookup(reg); // null on any failure (incl. creds not configured)
  if (!data || !(data.make || data.model || data.colour || data.fuel || data.engineCc)) {
    return res.status(200).json({ found: false });
  }

  // ── KEEP THE HISTORY WE JUST FETCHED, IF IT IS THIS CAR'S ─────────────────────────────────────
  // Only when the caller names a vehicle WE own: a first lookup on an unknown car has nothing to
  // attach to, and the readings land on the next lookup once the record exists. Best-effort — a
  // storage failure must never turn a working lookup into a failed one, which is this endpoint's
  // whole contract.
  //
  // AND ONLY WHEN THE PLATE MATCHES. This guard used to check tenant ownership alone, and did not
  // even select the registration, so it could not have compared. The Customer Details pane passes
  // the CARD'S vehicle with whatever plate is in the box, so a mistyped registration wrote another
  // car's entire MOT mileage history onto this one — at LOOKUP time, before any Save, with no
  // control anywhere that undoes it. Those readings feed mileage-based due items.
  //
  // Server-side and fail-closed on purpose: sameRegistration refuses an absent plate rather than
  // assuming a match, so a caller that omits one gets no write instead of the wrong one.
  const vehicleId = typeof req.query.vehicleId === 'string' ? req.query.vehicleId : null;
  if (vehicleId && data.odometerHistory?.length) {
    try {
      const session = await getServerSession(req, res, authOptions);
      const u = session?.user as any;
      if (u?.group_id) {
        const own = await prisma.vehicle.findFirst({ where: { id: vehicleId, group_id: u.group_id }, select: { id: true, registration: true } });
        if (own && sameRegistration(own.registration, reg)) {
          await recordOdometerReadings(prisma, { groupId: u.group_id, vehicleId, source: 'mot', readings: data.odometerHistory });
        } else if (own) {
          console.warn('[dvsa] odometer history withheld: looked up', reg, 'but vehicle', vehicleId, 'is', own.registration);
        }
      }
    } catch (e) { console.error('[dvsa] odometer store failed (non-fatal):', e); }
  }

  // odometerHistory is NOT returned to the client: it is stored server-side and read back through
  // lib/odometer. Shipping it would invite a second, client-shaped copy of the same facts.
  const { odometerHistory: _kept, ...forClient } = data;
  return res.status(200).json({ found: true, ...forClient });
}
