/**
 * File: pages/api/affiliate-site/waitlist.ts
 * "Tell me when the affiliate programme opens." POST { email, audience?, website? }.
 *
 * ── IT STORES, AND IT DOES NOT SEND ────────────────────────────────────────────────────────────
 * The owner reads the list in the Engine Room (/superadmin/affiliates). No notification email, and
 * that is a decision rather than an omission: the alerts slice owns who gets told about what, and
 * an email per waiting-list entry would mean every gate run that proves this endpoint works also
 * emails the owner — which is exactly why rep-site-gate refuses to drive its own happy path. One
 * list, read when he wants it.
 *
 * ── UNDER THE SITE'S OWN PREFIX ────────────────────────────────────────────────────────────────
 * /api/affiliate-site, not /api/affiliate. The second is a PUBLIC APEX namespace — check-code lives
 * there and the garage signup calls it — so putting this beside it would have tied a host-scoped
 * endpoint to a path the apex must keep open. middleware.ts records that trap at isAffiliateSite.
 *
 * ── A SECOND SUBMISSION IS NOT AN ERROR ────────────────────────────────────────────────────────
 * The email is unique: one person, one place in the queue. Somebody who comes back next week and
 * types it again gets the same thanks, not "you are already on the list" — there is nothing for
 * them to do about it, and the answer would also tell a stranger whether an address is on it.
 * Idempotent by upsert, so the original created_at survives and the queue keeps its order.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { validateWaitlist } from '@/lib/affiliate-waitlist';
import { takeTokenStrict, WAITLIST_LIMITS_BY_IP, waitlistIpKey, clientIp } from '@/lib/auth-rate-limit';

const THANKS = 'Thanks — we’ll email you when it opens.';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const body = (req.body || {}) as { email?: unknown; audience?: unknown; website?: unknown };

  // HONEYPOT FIRST, and accept-and-drop: a bot that fills the hidden field is told it worked, so it
  // has no signal to tune against. Before the limiter on purpose — a bot farm must not be able to
  // spend a real visitor's IP budget by filling the trap.
  if (typeof body.website === 'string' && body.website.trim() !== '') return res.status(200).json({ ok: true, message: THANKS });

  // THE LIMITER'S OWN clientIp, the one check-code uses — lib/turnstile exports a same-named helper
  // that can return undefined, which would key every anonymous caller under the string 'undefined'.
  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  if (!(await takeTokenStrict(waitlistIpKey(ip), WAITLIST_LIMITS_BY_IP.perIp.max, WAITLIST_LIMITS_BY_IP.perIp.windowMinutes))) {
    return res.status(429).json({ ok: false, message: 'Too many attempts from this connection. Please try again later.' });
  }

  const v = validateWaitlist(body);
  if (!v.ok) return res.status(400).json({ ok: false, message: v.message });

  try {
    await prisma.affiliateWaitlist.upsert({
      where: { email: v.fields.email },
      // THE AUDIENCE IS UPDATED, the date is not. Someone who answered "creator" and comes back to
      // say "trade" has corrected us; their place in the queue is still the day they first asked.
      // A null second time does NOT erase a stated answer — it means they did not say, again.
      update: v.fields.audience === null ? {} : { audience: v.fields.audience },
      create: { email: v.fields.email, audience: v.fields.audience },
      select: { id: true },
    });
  } catch (e) {
    // LOUD, because the person is about to be told something untrue if we pretend. This is the one
    // case that returns an error: there is no email fallback here, so a failed write means nobody
    // knows they asked.
    console.error('[affiliate-site/waitlist] could NOT store the entry — nobody has been told they asked', e);
    return res.status(500).json({ ok: false, message: 'We couldn’t save that just now. Please try again shortly.' });
  }

  return res.status(200).json({ ok: true, message: THANKS });
}
