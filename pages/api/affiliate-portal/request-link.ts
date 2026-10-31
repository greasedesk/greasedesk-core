/**
 * File: pages/api/affiliate-portal/request-link.ts
 * SEND AN AFFILIATE A SIGN-IN LINK. Reachable only on affiliates.greasedesk.com — middleware 404s
 * /api/affiliate-portal/* on every other host.
 *
 * ── THE SAME ANSWER EVERY TIME: 204 ─────────────────────────────────────────────────────────────
 * Whether the address is an affiliate, a suspended affiliate, a REP, or nobody at all. Affiliates
 * self-serve sign up, so anybody can guess addresses at this endpoint; an honest "no such affiliate"
 * would turn it into a membership oracle for the programme.
 *
 * ── IT MATCHES ONLY AFFILIATES, AND THAT IS NOT TIDINESS ────────────────────────────────────────
 * `party_type: 'affiliate'` is in the WHERE. A rep's address typed here gets 204 and no email: this
 * is not their door, and minting here would send a rep a link whose path is derived from THEIR party
 * (/rep/enter/…) built on THIS host, which 404s. The link would be unusable and the failure would
 * look like a broken email rather than a wrong door.
 *
 * ── THE LINK POINTS AT THE HOST THE REQUEST ARRIVED ON ──────────────────────────────────────────
 * A Host header is attacker-controlled in general. It is safe here for the reason the rep endpoint
 * records: middleware has already constrained it, because this route exists only on the affiliate
 * host and 404s everywhere else. Asserted in the gate, not assumed here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { mintRepLink, REP_LINK_MINUTES } from '@/lib/rep-magic-link';
import { sendNotification, PLATFORM_SEND } from '@/lib/notify';
import { takeToken, clientIp, AFFILIATE_REQUEST_LIMITS } from '@/lib/auth-rate-limit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const email = String(req.body?.email ?? '').trim().toLowerCase();

  // ITS OWN LIMITER KEY. Sharing the rep's would let either actor class exhaust the other's.
  const ok = await takeToken(
    `affreq:ip:${clientIp(req.headers)}`,
    AFFILIATE_REQUEST_LIMITS.perIp.max,
    AFFILIATE_REQUEST_LIMITS.perIp.windowMinutes,
  );
  if (!ok) return res.status(204).end(); // same answer as every other outcome

  const rep = email
    ? await prisma.rep.findFirst({
      where: { email, party_type: 'affiliate' },
      select: { id: true, email: true, status: true },
    })
    : null;

  // A SUSPENDED AFFILIATE IS NOT SENT A LINK, matching the rep endpoint's `status === 'active'`
  // test. Note this is Rep.status, not suspended_at: suspension stops NEW attribution and never
  // touches earned rewards, so if the owner ever wants a suspended affiliate to keep reading their
  // own earnings, the change belongs here and wants saying out loud rather than discovering.
  if (rep && rep.status === 'active') {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]
      || (req.headers.host?.startsWith('localhost') ? 'http' : 'https');
    const link = await mintRepLink({ repId: rep.id, sentTo: rep.email, baseUrl: `${proto}://${req.headers.host}` });
    await sendNotification({
      recipient: rep.email,
      template: 'affiliate_sign_in',
      groupId: PLATFORM_SEND, // an affiliate belongs to no garage; this is GreaseDesk writing to a partner
      subject: { type: 'rep', id: rep.id },
      data: { link: link.url, expiryMinutes: REP_LINK_MINUTES },
    });
  }
  return res.status(204).end();
}
