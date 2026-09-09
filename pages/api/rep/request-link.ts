/**
 * File: pages/api/rep/request-link.ts
 * SEND A REP A SIGN-IN LINK. Reachable only on reps.greasedesk.com — middleware 404s /api/rep/* on
 * every other host.
 *
 * ── THE SAME ANSWER EVERY TIME ──────────────────────────────────────────────────────────────────
 * 204, whether the address is a rep, a suspended rep, or nobody at all. The set of rep addresses is
 * small and closed (operator-created, no signup), which makes it exactly the set worth enumerating.
 * The cost of the honest sentence is nothing; the cost of the useful one is a list of our reps.
 *
 * ── THE LINK POINTS AT THE HOST THE REQUEST ARRIVED ON, AND THAT IS SAFE HERE ───────────────────
 * A Host header is attacker-controlled in general, and building an emailed credential URL from one
 * is how tokens get redirected. It is safe HERE because middleware.ts has already constrained it:
 * this route exists only on reps.greasedesk.com and 404s everywhere else, so by the time the
 * handler runs the host has been checked. The check is asserted in rep-host-gate, not assumed here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { mintRepLink, REP_LINK_MINUTES } from '@/lib/rep-magic-link';
import { sendNotification, PLATFORM_SEND } from '@/lib/notify';
import { takeToken, clientIp, REP_REQUEST_LIMITS } from '@/lib/auth-rate-limit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const email = String(req.body?.email ?? '').trim().toLowerCase();

  // RATE-LIMITED ON ITS OWN KEY. Not the customer link's — see lib/rep-magic-link's header for what
  // a shared key looked like when the gate suite exhausted one.
  const ok = await takeToken(`repreq:ip:${clientIp(req.headers)}`, REP_REQUEST_LIMITS.perIp.max, REP_REQUEST_LIMITS.perIp.windowMinutes);
  if (!ok) return res.status(204).end(); // same answer as every other outcome

  const rep = email ? await prisma.rep.findUnique({ where: { email }, select: { id: true, email: true, status: true } }) : null;
  if (rep && rep.status === 'active') {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || (req.headers.host?.startsWith('localhost') ? 'http' : 'https');
    const link = await mintRepLink({ repId: rep.id, sentTo: rep.email, baseUrl: `${proto}://${req.headers.host}` });
    await sendNotification({
      recipient: rep.email,
      template: 'rep_sign_in',
      groupId: PLATFORM_SEND, // a rep belongs to no garage; this is GreaseDesk writing to our own contractor
      subject: { type: 'rep', id: rep.id },
      data: { link: link.url, expiryMinutes: REP_LINK_MINUTES },
    });
  }
  return res.status(204).end();
}
