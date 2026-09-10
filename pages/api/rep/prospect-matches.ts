/**
 * File: pages/api/rep/prospect-matches.ts
 * GET ?name=&postcode= — garages that might be the one the rep is standing in front of.
 *
 * PRESENTED, NEVER MERGED. The rep confirms or rejects; nothing here writes. Garage-level fields only
 * — another rep's record may hold a named person and an email, and checking for a duplicate needs
 * neither (lib/prospect-store::findMatches shapes it).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireRepApi } from '@/lib/rep-auth';
import { findMatches } from '@/lib/prospect-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  const rep = await requireRepApi(req, res);
  if (!rep) return;
  const name = String(req.query.name ?? '').trim();
  if (name.length < 2) return res.status(200).json({ matches: [] });
  return res.status(200).json({ matches: await findMatches(name, String(req.query.postcode ?? '') || null) });
}
