/**
 * File: pages/api/stripe/connect.ts
 * ADMIN-ONLY. POST → a Stripe onboarding link for THIS tenant's own payments account.
 * GET  → the current connection state, resynced from Stripe when an account exists.
 *
 * State and storage are provider-agnostic (lib/provider-connection); everything Stripe-shaped is in
 * lib/stripe-connect. This endpoint is the Stripe-specific door onto both, and the registry entry in
 * lib/payment-providers is what points the page at it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { appBaseUrl } from '@/lib/stripe';
import { readConnection, providerState } from '@/lib/provider-connection';
import { refuseConnect, startOnboarding, syncAccount } from '@/lib/stripe-connect';
import { logStripeFailure, stripeFailureBody } from '@/lib/stripe-errors';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;

  const g = (await prisma.group.findUnique({ where: { id: groupId }, select: { country_code: true } })) as any;
  if (!g) return res.status(404).json({ message: 'Group not found.' });

  const row = await readConnection(groupId, 'stripe');

  if (req.method === 'GET') {
    // RESYNC ON READ when an account exists. Webhooks are the primary writer, but a missed or
    // delayed one must not leave a garage staring at a stale "finish setting up" for a day.
    if (row?.external_id) {
      try { return res.status(200).json({ state: await syncAccount(groupId, row.external_id) }); }
      // A failed resync is not worth an error page — the cached state is still true enough to
      // render. But it IS worth a log that says which of the six ways it failed.
      catch (e: any) { logStripeFailure('accounts.retrieve', e); }
    }
    return res.status(200).json({ state: providerState(row) });
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const refusal = await refuseConnect(groupId, g.country_code);
  if (refusal) return res.status(403).json(refusal);

  try {
    const base = appBaseUrl();
    const { url } = await startOnboarding({
      groupId,
      // BOTH legs come back to us, now to the Payments section rather than Settings → Invoicing.
      // `return_url` means only that the flow was exited — the page it lands on resyncs and decides
      // what to say. `refresh_url` catches an expired or reused link, a rejected account, or lost
      // access, and mints a new link rather than dead-ending.
      returnUrl: `${base}/admin/payments?connect=return`,
      refreshUrl: `${base}/admin/payments?connect=refresh`,
    });
    return res.status(200).json({ url });
  } catch (e: any) {
    // Our own preconditions first — they are not Stripe's failures and must not be dressed as them.
    const msg = String(e?.message ?? '');
    if (msg.startsWith('CONNECT:')) {
      console.error('[stripe] startOnboarding refused by us', msg);
      return res.status(409).json({ code: 'precondition', message: 'Could not start Stripe setup — please get in touch.', retryable: false });
    }
    // Everything else is Stripe's answer, and it gets classified rather than flattened. `scope` is
    // the OPERATION: accounts.create is where this path has actually been failing, and naming the
    // endpoint instead would have hidden that.
    const f = logStripeFailure('accounts.create/accountLinks.create', e);
    return res.status(f.status).json(stripeFailureBody(f));
  }
}
