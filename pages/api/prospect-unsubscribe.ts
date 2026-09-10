/**
 * File: pages/api/prospect-unsubscribe.ts
 * THE ONE PLACE A PROSPECT STOPS GREASEDESK'S EMAILS. POST only.
 *
 * Two callers, one door: the button on /u/[token], and a mail client acting on the List-Unsubscribe
 * header (RFC 8058 one-click, which POSTs `List-Unsubscribe=One-Click` with no page ever shown). The
 * token is in the query string for the second, because a one-click POST carries no body we control.
 *
 * GET IS REFUSED, never acted on — mail scanners follow links (see the page's header).
 *
 * NOT RATE LIMITED, deliberately: the token is 128 random bits, the only power it grants is stopping
 * email to one prospect, and a limiter on an unsubscribe is a way to make unsubscribing fail.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { unsubscribeByToken } from '@/lib/prospect-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Use the button — opening a link never unsubscribes.' }); }
  const token = String(req.query.t ?? (typeof req.body === 'object' ? req.body?.t : '') ?? '').trim();
  if (!token) return res.status(404).json({ message: 'Not found.' });
  const r = await unsubscribeByToken(token);
  if (!r.ok) return res.status(404).json({ message: 'Not found.' });
  return res.status(200).json({ ok: true, already: r.already });
}
