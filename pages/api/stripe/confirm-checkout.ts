/**
 * File: pages/api/stripe/confirm-checkout.ts
 * SYNCHRONOUS onboarding confirm (item-13). The billing wizard step calls this on the Checkout
 * return with the session_id. We retrieve the session SERVER-SIDE from Stripe (authenticated — this
 * is Stripe's truth, not the untrusted redirect params), verify it belongs to THIS tenant, and if a
 * trialing/active subscription exists we write the GroupBilling cache immediately. That means a
 * lagging webhook can never trap a paid tenant at a spinner — completion reads Stripe directly.
 * The webhook remains the async writer for everything after onboarding (renew/cancel/card-fail).
 * ADMIN-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';
import { requireAdminApi } from '@/lib/admin-guard';
import { getStripe } from '@/lib/stripe';
import { applyStripeSubscriptionToCache } from '@/lib/stripe-billing-cache';

const SUBSCRIBED = new Set(['trialing', 'active']);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;
  if (!groupId) return res.status(400).json({ message: 'No group in scope.' });

  const sessionId = (req.body && (req.body as any).session_id) as string | undefined;
  if (!sessionId) return res.status(400).json({ message: 'Missing session_id.' });

  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ message: 'Billing not configured.' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
    // The session MUST belong to this tenant — client_reference_id was set to group_id at creation.
    if (session.client_reference_id && session.client_reference_id !== groupId) {
      return res.status(403).json({ message: 'This checkout session is not for your account.' });
    }

    const sub = session.subscription;
    if (!sub || typeof sub === 'string') {
      // Subscription not attached yet (very early return) — still processing.
      return res.status(200).json({ onboarded: false, status: session.status ?? 'processing' });
    }

    const subscription = sub as Stripe.Subscription;
    await applyStripeSubscriptionToCache(subscription, groupId);
    const onboarded = SUBSCRIBED.has(subscription.status);
    return res.status(200).json({ onboarded, status: subscription.status });
  } catch (e: any) {
    console.error('[stripe] confirm-checkout error', e?.message);
    return res.status(502).json({ message: 'Could not confirm your subscription. Please refresh.' });
  }
}
