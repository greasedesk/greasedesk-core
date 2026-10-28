/**
 * File: pages/api/affiliate/check-code.ts
 * IS THIS REFERRAL CODE ONE WE KNOW — asked by the signup form as the field loses focus, so a typo
 * is caught by the person who can still fix it rather than discovered by an affiliate who never
 * got paid.
 *
 * ── IT ANSWERS VALIDITY, AND NOTHING ELSE ──────────────────────────────────────────────────────
 * No name, no email, no party type. A code is a published marketing token so the yes/no is not
 * much of a secret, but "GBJONES belongs to G B Jones" is a fact about a person, and an endpoint
 * that hands it over on request is an endpoint for harvesting the affiliate list. The form only
 * needs to know whether to show a warning.
 *
 * POST, not GET: a referral code has no business in a URL, where it reaches access logs, Referer
 * headers and anything caching in between.
 *
 * It NEVER blocks anything. The signup path does its own resolution and succeeds whatever this
 * says — this is advice to a human, not a gate.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { findPartyByRefCode } from '@/lib/attribution';
import { attributionMessage } from '@/lib/affiliate';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, message: null });
  }
  const code = (req.body as { code?: unknown } | undefined)?.code;
  try {
    const match = await findPartyByRefCode(prisma, code);
    switch (match.status) {
      case 'found':     return res.status(200).json({ ok: true, reason: 'attributed', message: null });
      case 'suspended': return res.status(200).json({ ok: false, reason: 'suspended', message: attributionMessage('suspended') });
      case 'ambiguous': return res.status(200).json({ ok: false, reason: 'ambiguous_code', message: attributionMessage('ambiguous_code') });
      case 'none':      return res.status(200).json({ ok: false, reason: 'unknown_code', message: attributionMessage('unknown_code') });
    }
  } catch (e) {
    // A LOOKUP FAILURE IS NOT A VERDICT. Saying "not recognised" because the database was briefly
    // unreachable would tell someone their valid code is wrong, and they might delete it.
    console.error('check-code failed:', e);
    return res.status(200).json({ ok: false, reason: 'unchecked', message: null });
  }
}
