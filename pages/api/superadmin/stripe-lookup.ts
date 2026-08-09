/**
 * File: pages/api/superadmin/stripe-lookup.ts
 * READ-ONLY Stripe inspection for operators. GET ?price=price_… | ?subscription=sub_…
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * A price switch is a money change that must be verified BEFORE anything is touched, and the facts
 * that matter — currency_options, tax_behavior, which product a price hangs off, a subscription's
 * item ids and its trial_end — live only in Stripe. The secret key is server-side by design, so
 * without a read surface the only way to check is to trust a description and hope.
 *
 * The same gap made the last two switches unverifiable: the earlier report assumed one product with
 * two prices, and the price turned out to be on a NEW product. That is exactly the sort of thing
 * this answers in one call rather than one assumption.
 *
 * READ-ONLY, and it must stay so. Nothing here creates, updates or deletes. A mutation belongs in a
 * purpose-built endpoint with its own confirmation, never in something whose name says "lookup".
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireOperatorApi } from '@/lib/operator-auth';
import { getStripe } from '@/lib/stripe';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOperatorApi(req, res, { minRole: 'owner' }); // money config → owner only
  if (!actor) return;

  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ message: 'Stripe is not configured.' });

  const priceId = String(req.query.price ?? '').trim();
  const subId = String(req.query.subscription ?? '').trim();

  try {
    if (priceId) {
      const p: any = await stripe.prices.retrieve(priceId, { expand: ['currency_options', 'product'] });
      return res.status(200).json({
        id: p.id,
        active: p.active,
        currency: p.currency,
        unit_amount: p.unit_amount,
        // THE FIELD THE CHECKOUT GUARD CANNOT SEE. inclusive vs exclusive is invisible in the
        // amount, and getting it wrong changes what a customer is charged, not just what we display.
        tax_behavior: p.tax_behavior,
        recurring: p.recurring ? { interval: p.recurring.interval, interval_count: p.recurring.interval_count, usage_type: p.recurring.usage_type } : null,
        // Every currency this price can charge. A price that carries options we no longer intend to
        // sell in is a price that can charge in them.
        currency_options: p.currency_options
          ? Object.fromEntries(Object.entries(p.currency_options).map(([k, v]: any) => [k, { unit_amount: v.unit_amount, tax_behavior: v.tax_behavior }]))
          : null,
        product: typeof p.product === 'object' ? { id: p.product.id, name: p.product.name, active: p.product.active } : p.product,
        livemode: p.livemode,
        created: new Date(p.created * 1000).toISOString(),
      });
    }

    if (subId) {
      const s: any = await stripe.subscriptions.retrieve(subId);
      return res.status(200).json({
        id: s.id,
        status: s.status,
        // trial_end is REPORTED, never assumed. A migration that silently ends a trial takes money
        // early from a tenant who was promised a free period.
        trial_end: s.trial_end ? new Date(s.trial_end * 1000).toISOString() : null,
        current_period_end: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
        cancel_at_period_end: s.cancel_at_period_end,
        currency: s.currency,
        customer: typeof s.customer === 'string' ? s.customer : s.customer?.id,
        // ITEM IDS are the point: a migration must REPLACE the existing item by id, not append a
        // second one — syncSubscriptionQuantity targets items.data[0].
        items: (s.items?.data ?? []).map((i: any) => ({
          item_id: i.id, price_id: i.price?.id, quantity: i.quantity,
          unit_amount: i.price?.unit_amount, currency: i.price?.currency,
          tax_behavior: i.price?.tax_behavior, product: i.price?.product,
        })),
        livemode: s.livemode,
      });
    }

    return res.status(400).json({ message: 'Give ?price=price_… or ?subscription=sub_…' });
  } catch (e: any) {
    return res.status(502).json({ message: 'Stripe lookup failed', detail: String(e?.message ?? e).slice(0, 300) });
  }
}
