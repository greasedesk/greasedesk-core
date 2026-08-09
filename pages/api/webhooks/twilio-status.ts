/**
 * File: pages/api/webhooks/twilio-status.ts
 * Twilio's delivery status callback. POST, form-encoded, signed with X-Twilio-Signature.
 *
 * ── WHAT THIS FIXES ─────────────────────────────────────────────────────────────────────────────
 * NotificationLog.status was written from the CREATE response, which is not the truth. Twilio
 * returns `accepted` — it has taken the message, not sent it. Two messages this week read `sent` in
 * our log and `failed` at Twilio (21704, an empty sender pool); five more read `sent` where Twilio
 * says `delivered`. The row and the provider disagreed and nothing could notice.
 *
 * ── THE RULES, AND WHERE THEY LIVE ──────────────────────────────────────────────────────────────
 * This route orchestrates; it decides nothing. The signature is lib/twilio-verify, the status
 * decision is lib/notification-status.ratchet — a pure predicate, because "a late `sent` must not
 * overwrite `delivered`" is a rule worth testing exhaustively without a provider in the loop.
 *
 * ── 204, FAST ───────────────────────────────────────────────────────────────────────────────────
 * Twilio retries on any non-2xx and on a slow handler, so a duplicate callback is expected traffic
 * rather than an anomaly. The ratchet makes a replay a no-op, which is what lets us answer quickly
 * and never worry about having answered twice.
 *
 * ── DORMANT UNTIL KEYED ─────────────────────────────────────────────────────────────────────────
 * No auth token or no pinned URL → 503 and nothing is processed. Same pattern as resend-inbound,
 * lib/stripe and lib/dvsa: a half-configured webhook must refuse rather than accept unverified
 * traffic, because an unverified status callback is an open invitation to mark anything delivered.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { verifyTwilioSignature, formParams } from '@/lib/twilio-verify';
import { ratchet, type NotifyStatus } from '@/lib/notification-status';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }

  // The signing key is the ACCOUNT'S AUTH TOKEN. If the adapter ever moves to an API Key pair, this
  // stays the Auth Token — they would then be two different secrets, and rotating the wrong one
  // breaks this route while the sending path carries on working. Worth knowing before that day.
  const authToken = process.env.SMS_API_KEY;
  const url = process.env.SMS_STATUS_CALLBACK_URL; // PINNED, never rebuilt from headers — see lib/twilio-verify
  if (!authToken || !url) return res.status(503).json({ message: 'Status callback not configured.' });

  const params = formParams(req.body);
  const verdict = verifyTwilioSignature({ authToken, url, params, header: req.headers['x-twilio-signature'] });
  if (!verdict.ok) {
    // 403 and nothing else. No detail: a caller probing the signature must learn nothing about why
    // it failed, and a genuine misconfiguration is diagnosed from OUR logs, not from the response.
    console.warn('[twilio-status] rejected:', verdict.reason);
    return res.status(403).json({ message: 'Invalid signature.' });
  }

  const sid = params.MessageSid || params.SmsSid;
  const providerStatus = params.MessageStatus || params.SmsStatus || '';
  if (!sid) return res.status(204).end(); // signed, but nothing to act on

  const row = await prisma.notificationLog.findFirst({
    where: { provider_message_id: sid },
    select: { id: true, status: true },
  });
  // A SIGNED CALLBACK FOR A ROW WE DO NOT HAVE IS NOT AN ERROR. Messages sent before this shipped
  // carry no provider id, and Twilio may callback for anything on the account. 204 and move on.
  if (!row) return res.status(204).end();

  const decision = ratchet(row.status as NotifyStatus, providerStatus);
  if (!decision.apply) {
    // The interesting case in production is `already_terminal` — that is a late or duplicate
    // callback being correctly refused, and it is worth being able to see that it happened.
    console.info('[twilio-status]', sid, providerStatus, '→ no change:', decision.reason);
    return res.status(204).end();
  }

  await prisma.notificationLog.update({
    where: { id: row.id },
    data: {
      status: decision.status as any,
      status_settled_at: new Date(),
      // The provider's own error code, on the row it explains. 30003 (unreachable handset) and
      // 21610 (recipient has opted out at the carrier) are different conversations with a garage,
      // and "failed" alone cannot tell them apart.
      ...(decision.status === 'failed'
        ? { error: params.ErrorCode ? `twilio ${params.ErrorCode}` : 'twilio reported the message as undelivered' }
        : {}),
    },
  }).catch((e: any) => { console.error('[twilio-status] update failed', sid, e?.message); });

  return res.status(204).end();
}
