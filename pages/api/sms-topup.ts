/**
 * File: pages/api/sms-topup.ts
 * POST { packs } → a Stripe Checkout URL for more SMS. ADMIN-only: it spends the garage's money.
 *
 * Nothing is granted here. The messages arrive when Stripe says the money did, via the platform
 * webhook — the same discipline as every other payment in the product. A success_url that granted
 * would hand a hundred messages to anyone who could guess the return address.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminApi } from '@/lib/admin-guard';
import { startTopUpCheckout, MAX_PACKS_PER_PURCHASE } from '@/lib/sms-topup';
import { smsAllowance } from '@/lib/sms-allowance';
import { prisma } from '@/lib/db';
import { logStripeFailure, stripeFailureBody } from '@/lib/stripe-errors';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;

  if (req.method === 'GET') {
    return res.status(200).json({ allowance: await smsAllowance(prisma, groupId), maxPacks: MAX_PACKS_PER_PURCHASE });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const packs = Number((req.body ?? {}).packs ?? 1);
  try {
    const r = await startTopUpCheckout({ groupId, packs });
    if (!r.ok) return res.status(409).json(r.refusal);
    return res.status(200).json({ url: r.url });
  } catch (e: any) {
    const f = logStripeFailure('checkout.sessions.create[sms_topup]', e);
    return res.status(f.status).json(stripeFailureBody(f));
  }
}
