/**
 * File: pages/api/unsubscribe.ts
 * POST ?t=<token> — a customer stops a garage's reminders and offers. Step 4 of the tenant
 * unsubscribe (owner decision B).
 *
 * ── POST ONLY ───────────────────────────────────────────────────────────────────────────────────
 * Opening a link must never act: mail scanners and link previewers follow every link in an email.
 * The page (/unsubscribe/[token]) shows a button; this is what the button, and a mail client's own
 * RFC 8058 one-click (`List-Unsubscribe=One-Click`), post to. GET is 405.
 *
 * ── HARMLESS TO REPEAT ──────────────────────────────────────────────────────────────────────────
 * The page's button and the mail client can both fire, in either order, and either twice. The writer
 * records a change once and a repeat as nothing (lib/contact-preferences::unsubscribeByLink).
 *
 * ── WHAT IT NEVER SAYS ──────────────────────────────────────────────────────────────────────────
 * The address. Nothing in any response names who the link was sent to — the holder of a forwarded
 * email learns only which garage it came from. No session is read or needed: the 192-bit token IS
 * the authority, and all it can do is stop marketing mail to the address it was minted for.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { unsubscribeByLink } from '@/lib/contact-preferences';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const token = String(req.query.t ?? (req.body && typeof req.body === 'object' ? req.body.t : '') ?? '');
  const result = await unsubscribeByLink(token);
  const oneClick = !!req.body && typeof req.body === 'object' && req.body['List-Unsubscribe'] === 'One-Click';
  const fromPage = !oneClick && /application\/x-www-form-urlencoded/.test(String(req.headers['content-type'] ?? ''));

  if (!result.ok) {
    if (result.why !== 'unknown') console.error('[unsubscribe] not recorded', result);
    if (fromPage) return res.redirect(303, `/unsubscribe/${encodeURIComponent(token)}`);
    return res.status(result.why === 'unknown' ? 404 : 500).json({ ok: false, reason: result.why === 'unknown' ? 'not_recognised' : 'not_recorded' });
  }
  // RFC 8058: the mail client wants a 2xx and nothing else.
  if (oneClick) return res.status(200).send('Unsubscribed.');
  // The page's own button: back to the page, which now reads "done" from the database.
  if (fromPage) return res.redirect(303, `/unsubscribe/${encodeURIComponent(token)}`);
  return res.status(200).json({ ok: true, garage: result.garage, channel: result.channel });
}
