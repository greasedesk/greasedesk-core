/**
 * File: pages/api/dvla-lookup.ts
 * Reg → DVLA VES vehicle data for the quick-create pre-fill (NEW cars only; the client calls this after
 * the internal vehicle-lookup misses). GET ?reg=. Server-side only — the DVLA key lives in lib/dvla,
 * never the client. Best-effort: always 200 with { found } so a lookup failure never blocks the form.
 * Authenticated (so the key isn't a public endpoint), but not site-scoped — it's public vehicle data.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { normalizeReg } from '@/lib/vehicle-identity';
import { dvlaLookup } from '@/lib/dvla';

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

  const data = await dvlaLookup(reg); // null on any failure (incl. no key configured)
  if (!data || !(data.make || data.colour || data.fuel || data.year || data.engineCc)) {
    return res.status(200).json({ found: false });
  }
  return res.status(200).json({ found: true, ...data });
}
