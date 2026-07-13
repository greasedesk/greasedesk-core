/**
 * File: pages/api/stripe/portal.ts
 * POST → a hosted Stripe Billing Portal URL (item-12). ADMIN-only. Card management, plan changes and
 * CANCELLATION all live here — we build NO bespoke cancel flow. Requires an existing customer (the
 * tenant has been through Checkout).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { getStripe, appBaseUrl } from '@/lib/stripe';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;

  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ message: 'Billing isn’t configured yet.' });
  const billing = await prisma.groupBilling.findUnique({ where: { group_id: vis.groupId }, select: { stripe_customer_id: true } });
  if (!billing?.stripe_customer_id) return res.status(409).json({ message: 'No subscription to manage yet.' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripe_customer_id,
      return_url: `${appBaseUrl()}/admin/settings/licences`,
    });
    return res.status(200).json({ url: session.url });
  } catch (e: any) {
    console.error('[stripe] portal error', e?.message);
    return res.status(502).json({ message: 'Could not open the billing portal.' });
  }
}
