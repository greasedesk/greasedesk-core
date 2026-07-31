/**
 * File: pages/api/webhooks/resend-inbound.ts
 * Resend `email.received`. TRANSPORT ONLY — verify, dedupe, hand off to lib/inbound.
 *
 * Deliberately the SAME SHAPE as pages/api/stripe/webhook.ts, in the same order, because that shape
 * is already proven here and a second webhook that verifies differently is a second thing to audit:
 *
 *   1. bodyParser OFF + readRaw()  — the signature covers the exact bytes
 *   2. verify BEFORE any processing — an unverified body is never read
 *   3. dedupe row written FIRST     — a replay collides on insert and gets 200 so retries stop
 *   4. process
 *   5. on a processing error, DELETE the dedupe row — so the provider's retry can re-attempt
 *
 * Dormant until keyed: no RESEND_INBOUND_WEBHOOK_SECRET → 503, nothing processed. Same
 * dormant-until-configured pattern as lib/stripe and lib/dvsa.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { verifySvixSignature } from '@/lib/svix-verify';
import { processInbound, type InboundPayload } from '@/lib/inbound';

export const config = { api: { bodyParser: false } };

function readRaw(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let len = 0;
    req.on('data', (c) => { const u = c as Uint8Array; chunks.push(u); len += u.length; });
    req.on('end', () => {
      const merged = new Uint8Array(len); let off = 0;
      for (const u of chunks) { merged.set(u, off); off += u.length; }
      resolve(Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength));
    });
    req.on('error', reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ message: 'Inbound not configured.' });

  const raw = await readRaw(req);
  const verdict = verifySvixSignature({
    rawBody: raw,
    svixId: req.headers['svix-id'] as string | undefined,
    svixTimestamp: req.headers['svix-timestamp'] as string | undefined,
    svixSignature: req.headers['svix-signature'] as string | undefined,
    secret,
  });
  if (!verdict.ok) {
    console.error('[inbound] signature rejected:', verdict.reason);
    return res.status(400).json({ message: 'Invalid signature.' }); // never process an unverified body
  }

  let payload: InboundPayload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).json({ message: 'Malformed body.' }); }

  // DEDUPE ON THE SVIX DELIVERY ID. Never on data.message_id — that is the SENDER'S RFC header and
  // is attacker-controlled, so deduping on it would let anyone suppress a genuine inbound message
  // by pre-sending one that claims the same header.
  try {
    await prisma.inboundEvent.create({ data: { svix_id: verdict.svixId, type: String(payload.type ?? 'unknown'), email_id: payload.data?.email_id ?? null } });
  } catch {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    if (payload.type !== 'email.received') return res.status(200).json({ received: true, ignored: payload.type ?? null });
    const outcome = await processInbound(prisma, payload);
    console.log('[inbound]', JSON.stringify(outcome));
    return res.status(200).json({ received: true, ...outcome });
  } catch (e: any) {
    // Clear the dedupe row so the retry can re-attempt — otherwise a transient fault silently
    // consumes the only delivery of a customer's message.
    await prisma.inboundEvent.delete({ where: { svix_id: verdict.svixId } }).catch(() => {});
    console.error('[inbound] processing error', e?.message);
    return res.status(500).json({ message: 'Processing error.' });
  }
}
