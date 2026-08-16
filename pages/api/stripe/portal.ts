/**
 * File: pages/api/stripe/portal.ts
 * POST → a hosted Stripe Billing Portal URL (item-12). ADMIN-only. Card management, plan changes and
 * CANCELLATION all live here — we build NO bespoke cancel flow. Requires an existing customer (the
 * tenant has been through Checkout).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { refuseDemoBilling } from '@/lib/demo-tenant';
import { getStripe, appBaseUrl } from '@/lib/stripe';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;

  // A demo has no customer, so the 409 below would already stop it — but the refusal is stated
  // here anyway. Relying on "there happens to be no row" makes the guarantee an accident of data;
  // the moment anything writes a GroupBilling row for a demo, the accident stops holding.
  if (await refuseDemoBilling(res, vis.groupId)) return;

  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ message: 'Billing isn’t configured yet.' });
  if (!vis.groupId) return res.status(401).json({ message: 'Not authenticated.' });
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
