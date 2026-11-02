/**
 * File: pages/api/marketing-unsubscribe.ts
 * THE ONE PLACE SOMEBODY STOPS GREASEDESK'S MARKETING EMAIL. POST only.
 *
 * Renamed from prospect-unsubscribe when the engine took on three more audiences: the old name
 * described one of the four populations it now serves, and an affiliate reading
 * `/api/prospect-unsubscribe` in a link would be told they are a prospect. Nothing was lost in the
 * rename — the prospect sequence had never sent an email, so no live link pointed at the old path.
 *
 * Two callers, one door: the button on /u/[token], and a mail client acting on the
 * List-Unsubscribe header (RFC 8058 one-click, which POSTs `List-Unsubscribe=One-Click` with no page
 * ever shown). The token is in the query string for the second, because a one-click POST carries no
 * body we control.
 *
 * GET IS REFUSED, never acted on — mail scanners follow links.
 *
 * NOT RATE LIMITED, deliberately: the token is 128 random bits, the only power it grants is stopping
 * email, and a limiter on an unsubscribe is a way to make unsubscribing fail.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { unsubscribeByToken } from '@/lib/marketing-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Use the button — opening a link never unsubscribes.' }); }
  const token = String(req.query.t ?? (typeof req.body === 'object' ? req.body?.t : '') ?? '').trim();
  if (!token) return res.status(404).json({ message: 'Not found.' });
  const r = await unsubscribeByToken(token);
  if (!r.ok) return res.status(404).json({ message: 'Not found.' });
  return res.status(200).json({ ok: true, already: r.already, stopped: r.stopped });
}
