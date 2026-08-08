/**
 * File: pages/api/superadmin/sms-lookup.ts
 * GET ?sid=SM… → what the provider now says about a message we sent. OPERATOR ONLY.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The create response cannot answer the question that matters. Sending through a Messaging Service
 * returns status `accepted` with `from: null` and `num_segments: 0` — Twilio has taken the message
 * but has NOT yet chosen a sender from the pool. So the one fact we most need on record, whether the
 * alphanumeric `GreaseDesk` went out or it fell back to the bare number, is simply not in the reply
 * we store. It only exists once the message is processed.
 *
 * Reading it back is the cheap way to see it. The proper long-term answer is a status-callback
 * webhook that upgrades the NotificationLog row when the provider reports delivery — this endpoint
 * is the support-desk version of that, and the thing that makes "which sender did they see?"
 * answerable today.
 *
 * ── IT NEVER RETURNS THE BODY ───────────────────────────────────────────────────────────────────
 * Deliberately. Verification codes travel in bodies, and an endpoint that hands an operator the
 * contents of a customer's or a garage owner's text is a far larger thing than a diagnostic. Sender,
 * status, segments and timestamps only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireOperatorApi } from '@/lib/operator-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOperatorApi(req, res); // wrong actor class → 404
  if (!actor) return;

  const sid = String(req.query.sid ?? '').trim();
  if (!/^SM[0-9a-fA-F]{32}$/.test(sid)) return res.status(400).json({ message: 'Give a message SID (SM…).' });

  const account = process.env.SMS_ACCOUNT_SID;
  const key = process.env.SMS_API_KEY;
  const keySid = process.env.SMS_KEY_SID || account;
  if (!account || !key) return res.status(503).json({ message: 'SMS is not configured.' });

  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Messages/${sid}.json`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${keySid}:${key}`).toString('base64') },
  });
  if (!r.ok) return res.status(502).json({ message: `Provider lookup failed: ${r.status}`, detail: (await r.text()).slice(0, 300) });
  const j: any = await r.json();

  return res.status(200).json({
    sid: j.sid,
    // THE ANSWER. An alphanumeric sender comes back as the text 'GreaseDesk'; a fallback comes back
    // as a +44… number, and the difference is the whole point of looking.
    from: j.from ?? null,
    messagingServiceSid: j.messaging_service_sid ?? null,
    status: j.status ?? null,
    numSegments: j.num_segments ?? null,
    errorCode: j.error_code ?? null,
    errorMessage: j.error_message ?? null,
    dateSent: j.date_sent ?? null,
    price: j.price ?? null,
    priceUnit: j.price_unit ?? null,
  });
}
