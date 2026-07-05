/**
 * File: pages/api/dvsa-lookup.ts
 * Reg → DVSA MOT History vehicle data for the quick-create pre-fill (NEW cars only; the client calls
 * this after the internal vehicle-lookup misses). GET ?reg=. Server-side only — OAuth token + api key
 * live in lib/dvsa, never the client. Best-effort: always 200 with { found } so a lookup failure never
 * blocks the form. Authenticated (so the credentials aren't a public endpoint).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { normalizeReg } from '@/lib/vehicle-identity';
import { dvsaLookup } from '@/lib/dvsa';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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
  return res.status(200).json({ found: true, ...data });
}
