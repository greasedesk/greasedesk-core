/**
 * File: pages/api/stripe/webhook.ts
 * THE only writer of subscription state (item-12). Signature-verified against STRIPE_WEBHOOK_SECRET;
 * every event deduped on event.id (StripeEvent ledger) and treated as replayable. The Checkout
 * redirect writes nothing — this is the ledger. Writes are naturally idempotent (they set the cache
 * to Stripe's CURRENT truth), so a replay is a no-op even beyond the dedupe.
 *
 * Raw body required for signature verification → bodyParser OFF.
 *
 * EVENTS THIS ENDPOINT MUST BE SUBSCRIBED TO IN THE STRIPE DASHBOARD:
 *   checkout.session.completed, customer.subscription.{created,updated,deleted,paused,resumed},
 *   invoice.paid, invoice.payment_failed, charge.refunded,
 *   customer.updated  ← ADDED 2026-08-06 for the country-mismatch check; without it a country
 *                       corrected in the Portal is never compared again.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { getStripe, stripeWebhookSecret } from '@/lib/stripe';
import { applyStripeSubscriptionToCache } from '@/lib/stripe-billing-cache';
import { accrueFromInvoicePaid, clawbackFromChargeRefunded } from '@/lib/commission-billing';
import { countryMismatch } from '@/lib/billing-country';
import { writeAudit } from '@/lib/audit';

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

/**
 * ONE place the comparison is made and reported. An AuditLog row rather than a console line,
 * because the console is unreadable after the fact and this is the kind of fault that is only ever
 * noticed later — the row names both countries and the event that revealed them.
 * Never throws: a reporting failure must not fail a webhook Stripe will then retry forever.
 */
async function reportCountryMismatch(groupId: string | null, stripeCountry: string | null, via: string): Promise<void> {
  try {
    if (!groupId) return;
    const g = await prisma.group.findUnique({ where: { id: groupId }, select: { country_code: true, ref: true } });
    const m = countryMismatch(g?.country_code, stripeCountry);
    if (!m) return;
    console.warn(`[stripe] COUNTRY MISMATCH ${g?.ref}: GreaseDesk says ${m.groupCountry}, Stripe says ${m.stripeCountry} (via ${via})`);
    await writeAudit(prisma as any, {
      groupId, userId: null, action: 'billing.country_mismatch',
      entity: 'group', entityId: groupId,
      diff: { groupCountry: m.groupCountry, stripeCountry: m.stripeCountry, via },
    });
  } catch { /* never let this fail the webhook */ }
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
        // WHAT COUNTRY DID STRIPE ACTUALLY RECORD? It is on the session already
        // (customer_details.address.country) — no extra API call — and it is the first moment the
        // payer's answer exists. A disagreement with Group.country_code decides the wrong TAX
        // REGIME once automatic_tax is on, so it must surface here rather than in a tax return.
        await reportCountryMismatch(groupId, s.customer_details?.address?.country ?? null, 'checkout.session.completed');
        if (subId) { const sub = await stripe.subscriptions.retrieve(subId); await applyStripeSubscriptionToCache(sub, groupId); }
        break;
      }
      // The address can change AFTER checkout — a correction in the Portal, or an update we make.
      // Same comparison, same reporter, so a later divergence is caught by the same rule.
      case 'customer.updated': {
        const c = event.data.object as Stripe.Customer;
        const row = await prisma.groupBilling.findFirst({ where: { stripe_customer_id: c.id }, select: { group_id: true } });
        await reportCountryMismatch(row?.group_id ?? null, c.address?.country ?? null, 'customer.updated');
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
      // RECORDED, NOT ANCHORED (ruling 2026-08-06). A single decline is often transient and clears
      // on the next retry; anchoring here would show a seven-day countdown that then vanishes,
      // which is worse than none. The clock starts when Stripe reaches past_due, in the
      // subscription cases above. This exists so the failure is visible in the event log at all —
      // before today nothing reacted to it whatsoever.
      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const subId = typeof (inv as any).subscription === 'string' ? (inv as any).subscription : (inv as any).subscription?.id;
        console.warn(`[stripe] invoice.payment_failed invoice=${inv.id} subscription=${subId ?? 'none'} attempt=${(inv as any).attempt_count ?? '?'} — recorded; the grace clock starts at past_due, not here`);
        break;
      }
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
