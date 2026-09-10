/**
 * File: pages/api/rep/prospects.ts
 * POST — a rep records a visit to a garage that is not a GreaseDesk customer.
 *
 * THE REP IS FROM THE SESSION, never the body: who recorded a visit is part of the trail a later
 * reader follows, and it must not be something a request can claim.
 *
 * Every rule is lib/prospect-store's. This file shapes a request into a call and a refusal into a
 * sentence, and decides nothing — two places deciding what a visit means is how they drift.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireRepApi } from '@/lib/rep-auth';
import { recordVisit } from '@/lib/prospect-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const rep = await requireRepApi(req, res);
  if (!rep) return;
  const b = req.body ?? {};
  // CONSENT IS THREE-STATE ON THE WAY IN. Only an explicit true or false is an answer; anything else —
  // absent, null, a string — is "not asked", never coerced into a no, and certainly never into a yes.
  const consent = b.consent === true ? true : b.consent === false ? false : null;
  const visitedOn = b.visitedOn ? new Date(String(b.visitedOn)) : new Date();
  if (Number.isNaN(visitedOn.getTime())) return res.status(400).json({ message: 'That visit date is not a date.' });

  try {
    const r = await recordVisit({
      repId: rep.repId,
      prospectId: typeof b.prospectId === 'string' && b.prospectId ? b.prospectId : null,
      garage: b.garage ? { name: String(b.garage.name ?? ''), addressLine1: b.garage.addressLine1 ?? null, locality: b.garage.locality ?? null, postcode: b.garage.postcode ?? null } : undefined,
      visit: { visitedOn, spokeTo: b.visit?.spokeTo ?? null, note: b.visit?.note ?? null, status: String(b.visit?.status ?? '') },
      email: b.email ?? null,
      consent,
    });
    if (!r.ok) return res.status(409).json({ code: r.code, message: r.message });
    return res.status(200).json(r);
  } catch (e) {
    if (String((e as Error).message) === 'PROSPECT_NOT_FOUND') return res.status(404).json({ message: 'That garage is no longer on record.' });
    throw e;
  }
}
