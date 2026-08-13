/**
 * File: pages/api/stripe/connect.ts
 * ADMIN-ONLY. POST → a Stripe onboarding link for THIS tenant's own payments account.
 * GET  → the current connection state, resynced from Stripe when an account exists.
 *
 * Nothing here takes a payment. A garage can connect, and the only thing that changes is that the
 * product can later offer card payments — which is a separate slice.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { appBaseUrl } from '@/lib/stripe';
import { connectState, refuseConnect, startOnboarding, syncAccount } from '@/lib/stripe-connect';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;

  const g = (await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      country_code: true, stripe_account_id: true, stripe_charges_enabled: true,
      stripe_payouts_enabled: true, stripe_disabled_reason: true, stripe_requirements_due: true,
      stripe_disconnected_at: true,
    },
  })) as any;
  if (!g) return res.status(404).json({ message: 'Group not found.' });

  if (req.method === 'GET') {
    // RESYNC ON READ when an account exists. Webhooks are the primary writer, but a missed or
    // delayed one must not leave a garage staring at a stale "finish setting up" for a day.
    if (g.stripe_account_id) {
      try { return res.status(200).json({ state: await syncAccount(groupId, g.stripe_account_id) }); }
      catch (e: any) { console.error('[connect] resync failed', e?.message); }
    }
    return res.status(200).json({ state: connectState(g) });
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const refusal = await refuseConnect(groupId, g.country_code);
  if (refusal) return res.status(403).json(refusal);

  try {
    const base = appBaseUrl();
    const { url } = await startOnboarding({
      groupId,
      // BOTH legs come back to us. `return_url` means only that the flow was exited — the page it
      // lands on resyncs and decides what to say. `refresh_url` catches an expired or reused link,
      // a rejected account, or lost access, and mints a new link rather than dead-ending.
      returnUrl: `${base}/admin/settings/invoicing?connect=return`,
      refreshUrl: `${base}/admin/settings/invoicing?connect=refresh`,
    });
    return res.status(200).json({ url });
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    if (msg.startsWith('CONNECT:')) return res.status(409).json({ message: 'Could not start Stripe setup — please try again.' });
    console.error('[connect] onboarding error', msg);
    return res.status(502).json({ message: 'Stripe couldn’t be reached. Please try again.' });
  }
}
