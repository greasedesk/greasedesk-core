/**
 * File: pages/api/stripe/account-session.ts
 * ADMIN-ONLY. POST → a short-lived Account Session client secret, so Stripe's embedded components
 * can render this tenant's own payments inside /admin/payments.
 *
 * ── THE ACCOUNT IS RESOLVED FROM THE SESSION, NEVER FROM THE REQUEST ────────────────────────────
 * There is no account parameter and there must never be one. The connected account comes from the
 * signed-in user's tenant, and the capability comes from their role via paymentsAccessFor — so the
 * worst a malicious client can do is ask for a session it was already entitled to.
 *
 * ── THE COMPONENTS BLOCK IS THE PERMISSION ──────────────────────────────────────────────────────
 * Stripe grants refunds, disputes and capture at mint time. Rendering fewer buttons than the session
 * allows is decoration; the session itself is the control. See lib/stripe-account-session.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminApi } from '@/lib/admin-guard';
import { stripePublishableKey } from '@/lib/stripe';
import { readConnection, providerState } from '@/lib/provider-connection';
import { paymentsAccessFor, createAccountSession } from '@/lib/stripe-account-session';
import { logStripeFailure, stripeFailureBody } from '@/lib/stripe-errors';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;

  const access = paymentsAccessFor(vis);
  if (access === 'none') return res.status(403).json({ message: 'You don’t have access to payments.' });

  // ORDER MATTERS — the same lesson refuseConnect learned. Test the TENANT before the ENVIRONMENT.
  // A garage that has never connected must be told that, not told the view is switched off for this
  // deployment: the second is a fact about us, it would become the wrong answer the moment the key
  // landed, and the gate caught this endpoint doing exactly that.
  const row = await readConnection(groupId, 'stripe');
  const state = providerState(row);
  // Only a live account has anything to show. An incomplete or restricted one is handled by the
  // page's own state copy, which tells the garage what to do about it — a Stripe component would
  // render an empty box next to that message and contradict it.
  if (state.status !== 'ready') return res.status(409).json({ code: state.status, message: 'This account isn’t set up to take payments yet.' });

  const publishableKey = stripePublishableKey();
  // A distinct code, because the page says something specific about it: the connection is fine, it
  // is the in-page VIEW that isn't switched on for this environment.
  if (!publishableKey) return res.status(409).json({ code: 'no_publishable_key', message: 'The in-page payments view isn’t switched on for this environment yet.' });

  try {
    const { clientSecret, expiresAt } = await createAccountSession(state.externalId, access);
    return res.status(200).json({ clientSecret, expiresAt, publishableKey, access });
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    if (msg.startsWith('CONNECT:')) {
      console.error('[stripe] accountSessions.create refused by us', msg);
      return res.status(409).json({ code: 'precondition', message: 'The payments view isn’t available right now.', retryable: false });
    }
    const f = logStripeFailure('accountSessions.create', e);
    return res.status(f.status).json(stripeFailureBody(f));
  }
}
