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
 *
 * ── RATE-LIMITED, BECAUSE IT IS PUBLIC NOW (owner, 2026-10-29) ─────────────────────────────────
 * Since /pricing started quoting the referral offer this is called by every visitor arriving with
 * a ?ref=, not only by the signup form. Sixty an hour per IP on its own `refcode:ip:` key
 * (lib/auth-rate-limit explains the figure and why it is generous rather than tight).
 *
 * OVER THE LIMIT IT ANSWERS `ok: false`, which is what the pricing page reads: it shows the
 * standard prices, exactly as for a code we do not know. But the REASON is `rate_limited` and the
 * MESSAGE is null, NOT the unknown-code wording — and that distinction is the whole care in this
 * change. The signup form shows `message` to a person. Telling a legitimately referred garage
 * "that code is not one we recognise" because somebody else behind the same office NAT browsed a
 * lot is the error this file's own header warns about: they might delete a code that was right.
 * So the page falls back and the human is told nothing, which is the same shape as the
 * lookup-failed branch below and for the same reason.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { findPartyByRefCode } from '@/lib/attribution';
import { attributionMessage } from '@/lib/affiliate';
import { takeToken, refCodeIpKey, clientIp, REF_CODE_LIMITS } from '@/lib/auth-rate-limit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ ok: false, message: null });
  }
  const code = (req.body as { code?: unknown } | undefined)?.code;

  // BEFORE THE LOOKUP, so a burst costs no queries beyond the limiter's own count. takeToken is
  // the fail-OPEN variant: nothing here spends money, and a limiter outage must not stop the
  // public page pricing itself correctly.
  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  if (!(await takeToken(refCodeIpKey(ip), REF_CODE_LIMITS.perIp.max, REF_CODE_LIMITS.perIp.windowMinutes))) {
    // `ok: false` so the pricing page shows the standard prices; `message: null` so no person is
    // told their valid code is wrong. See the header.
    return res.status(200).json({ ok: false, reason: 'rate_limited', message: null });
  }

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
