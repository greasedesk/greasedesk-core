/**
 * File: pages/api/stripe/webhook.ts
 * THE only writer of subscription state (item-12). Signature-verified against STRIPE_WEBHOOK_SECRET;
 * every event deduped on event.id (StripeEvent ledger) and treated as replayable. The Checkout
 * redirect writes nothing — this is the ledger. Writes are naturally idempotent (they set the cache
 * to Stripe's CURRENT truth), so a replay is a no-op even beyond the dedupe.
 *
 * Raw body required for signature verification → bodyParser OFF.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getStripe, stripeWebhookSecret } from '@/lib/stripe';
import { applyStripeSubscriptionToCache } from '@/lib/stripe-billing-cache';
import { accrueFromInvoicePaid, clawbackFromChargeRefunded } from '@/lib/commission-billing';

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
  const stripe = getStripe();
  const secret = stripeWebhookSecret();
  if (!stripe || !secret) return res.status(503).json({ message: 'Billing not configured.' });

  let event: Stripe.Event;
  try {
    const raw = await readRaw(req);
    // Cast bypasses a TS lib friction (Node Buffer vs Uint8Array<ArrayBuffer> generic); runtime
    // takes the exact raw bytes, which is what signature verification requires.
    event = stripe.webhooks.constructEvent(raw as any, req.headers['stripe-signature'] as string, secret);
  } catch (e: any) {
    console.error('[stripe] signature verification failed', e?.message);
    return res.status(400).json({ message: 'Invalid signature.' }); // never process an unverified body
  }

  // Dedupe: record the event.id FIRST; a replay collides and is skipped (return 200 so Stripe stops).
  try {
    await prisma.stripeEvent.create({ data: { event_id: event.id, type: event.type } });
  } catch {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const groupId = s.client_reference_id || null;
        const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
        const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
        if (groupId && customerId) {
          // Seed the customer link so later subscription.* events map by customer id.
          await prisma.groupBilling.update({ where: { group_id: groupId }, data: { stripe_customer_id: customerId, stripe_subscription_id: subId ?? undefined } }).catch(() => {});
        }
        if (subId) { const sub = await stripe.subscriptions.retrieve(subId); await applyStripeSubscriptionToCache(sub, groupId); }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        await applyStripeSubscriptionToCache(event.data.object as Stripe.Subscription, null);
        break;
      }
      // ── COMMISSION (platform layer 2). A collected subscription payment → accrual; a refund →
      // clawback. Both go through lib/commission-billing → the commission engine (never computed here).
      // Idempotent twice over: this event.id (StripeEvent, above) AND the ledger's source_ref
      // (invoice/refund id), so a re-delivery or a duplicate-typed event can't double-write.
      case 'invoice.paid': {
        const r = await accrueFromInvoicePaid(prisma, event.data.object as Stripe.Invoice);
        console.log('[stripe] invoice.paid →', JSON.stringify(r));
        break;
      }
      case 'charge.refunded': {
        const r = await clawbackFromChargeRefunded(prisma, event.data.object as Stripe.Charge);
        console.log('[stripe] charge.refunded →', JSON.stringify(r));
        break;
      }
      default:
        break; // other events acknowledged, not acted on
    }
    return res.status(200).json({ received: true });
  } catch (e: any) {
    // On a processing error, REMOVE the dedupe row so Stripe's retry can re-attempt.
    await prisma.stripeEvent.delete({ where: { event_id: event.id } }).catch(() => {});
    console.error('[stripe] webhook processing error', event.type, e?.message);
    return res.status(500).json({ message: 'Processing error.' });
  }
}
