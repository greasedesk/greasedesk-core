/**
 * File: pages/api/stripe/checkout.ts
 * POST → a hosted Stripe Checkout Session URL (item-12). ADMIN-only. Subscription mode, one Price
 * (£35/mo GBP licensed), quantity = the tenant's site count. Card VERIFIED + 3DS-authenticated at
 * day 1 but NOT charged (trial_period_days), so the day-61 conversion is an OFF-SESSION charge
 * against an authenticated card with an established mandate — it cannot fail SCA.
 *   payment_method_collection:'always' → a card is required to start the trial (no card, no trial).
 *   Stripe Tax is enabled ONLY when GreaseDesk Ltd is VAT-registered (GARAGE_VAT_REGISTERED) —
 *   flat £35 today; flip that one flag and Checkout adds VAT automatically. The price is £35 flat.
 *   client_reference_id = group_id → the webhook maps the subscription back with zero trust in the
 *   redirect. The redirect writes NOTHING; the webhook is the ledger.
 * Idempotency key = group_id + site count, so a double-submit reuses one session.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { getStripe, stripePriceId, appBaseUrl, TRIAL_PERIOD_DAYS } from '@/lib/stripe';
import { GARAGE_VAT_REGISTERED } from '@/lib/billing-pricing';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;

  const stripe = getStripe();
  const priceId = stripePriceId();
  if (!stripe || !priceId) return res.status(503).json({ message: 'Billing isn’t configured yet.' });

  const groupId = vis.groupId as string;
  if (!groupId) return res.status(400).json({ message: 'No group in scope.' });
  const [group, siteCount, billing] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, billing_email: true } }),
    prisma.site.count({ where: { group_id: groupId } }),
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { stripe_customer_id: true } }),
  ]);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  const quantity = Math.max(1, siteCount);
  const base = appBaseUrl();

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity }],
      // Trial with a mandatory, authenticated card (see file header) — the SCA-safe conversion.
      // missing_payment_method: 'create_invoice' (ruling 2026-07-14): if the card is missing/fails
      // at trial end, ISSUE the invoice and let Stripe dunning chase for ~2 weeks — only THEN does
      // the sub go past_due → (later) lapsed. 'cancel' was the harshest reading of a soft failure —
      // it would drop the tenant into read-only mid-morning with no warning.
      subscription_data: {
        trial_period_days: TRIAL_PERIOD_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
      },
      payment_method_collection: 'always',
      // Stripe Tax ONLY when GreaseDesk Ltd is VAT-registered — flat £35 until the flag flips.
      ...(GARAGE_VAT_REGISTERED
        ? { automatic_tax: { enabled: true }, billing_address_collection: 'required' as const, tax_id_collection: { enabled: true } }
        : {}),
      client_reference_id: groupId,
      ...(billing?.stripe_customer_id
        ? { customer: billing.stripe_customer_id }
        : { customer_email: group.billing_email ?? undefined }),
      success_url: `${base}/admin/settings/licences?billing=success`,
      cancel_url: `${base}/admin/settings/licences?billing=cancelled`,
    }, { idempotencyKey: `checkout:${groupId}:${quantity}` });

    return res.status(200).json({ url: session.url });
  } catch (e: any) {
    console.error('[stripe] checkout error', e?.message);
    return res.status(502).json({ message: 'Could not start checkout.' });
  }
}
