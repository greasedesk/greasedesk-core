/**
 * File: pages/api/superadmin/migrate-subscription-price.ts
 * ONE-SHOT: move sub_1U1iDqDu8OXvJikwfg0YNGoB from the old tax-EXCLUSIVE price to the new
 * tax-INCLUSIVE one. Owner-only. POST ?dryRun=1 to check every precondition and write nothing.
 *
 * ── WHY THE IDS ARE IN THE SOURCE ───────────────────────────────────────────────────────────────
 * This is deliberately NOT a general "update any subscription's price" endpoint. A surface that can
 * repoint any tenant's billing at any price is a permanent hazard built for a single afternoon's
 * work; hard-coding the three ids means the only thing it can do is the thing it was reviewed for,
 * and a second migration is a second reviewed commit rather than a form somebody fills in.
 *
 * ── THE WINDOW THIS CLOSES ──────────────────────────────────────────────────────────────────────
 * The env vars now name the NEW price, and lib/stripe-billing-cache derives module entitlement from
 * the subscription's LINE ITEM price ids through that same map. While this subscription still
 * carries the OLD id, any customer.subscription.updated for it resolves to NO modules — a Stripe
 * retry or a site being added (syncSubscriptionQuantity fires an update) is enough. So this is
 * time-sensitive, not tidy-up.
 *
 * ── REPLACE, NEVER APPEND ───────────────────────────────────────────────────────────────────────
 * The item is addressed BY ID. Appending a second item would leave two line items and
 * syncSubscriptionQuantity reads items.data[0] — it would then re-rate whichever Stripe happened to
 * return first, silently, on the next site change.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { getStripe } from '@/lib/stripe';

/** The ONLY subscription this endpoint may touch. */
const SUB_ID = 'sub_1U1iDqDu8OXvJikwfg0YNGoB';
const ITEM_ID = 'si_V1llfct0nMfOzY';
const FROM_PRICE = 'price_1U1WeSDu8OXvJikwnUnhzq1V'; // GBP 7500 EXCLUSIVE, prod_V1ZiRMQ7jAs6bc
const TO_PRICE = 'price_1U2RfYDu8OXvJikwUsR3NmHZ';   // GBP 7500 INCLUSIVE, prod_V2WiIjJUsLBzkC
const EXPECT = { currency: 'gbp', unit_amount: 7500, tax_behavior: 'inclusive' } as const;

const iso = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toISOString() : null);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const actor = await requireOperatorApi(req, res, { minRole: 'owner' });
  if (!actor) return;

  const dryRun = String(req.query.dryRun ?? '') === '1';
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ message: 'Stripe is not configured.' });

  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail: string) => { checks.push({ check, ok, detail }); return ok; };
  const refuse = (message: string) => res.status(409).json({ ok: false, dryRun, message, checks });

  try {
    // 1 ── THE ENV MUST ALREADY NAME THE NEW PRICE. Migrating first would leave the subscription on
    // a price Checkout no longer sells and entitlement no longer maps — the inconsistency running
    // the wrong way. Checked, not trusted: today a "Ready" deployment twice wasn't the live code.
    const envPrice = process.env.STRIPE_PRICE_ID ?? null;
    const envCore = process.env.STRIPE_PRICE_CORE ?? null;
    if (!add('STRIPE_PRICE_ID is the new price', envPrice === TO_PRICE, String(envPrice))) {
      return refuse('STRIPE_PRICE_ID does not name the new price — set the env vars before migrating.');
    }
    // The `??` fallback means a stale CORE would win over a correct PRICE_ID for entitlement.
    if (!add('STRIPE_PRICE_CORE agrees', (envCore ?? envPrice) === TO_PRICE, String(envCore))) {
      return refuse('STRIPE_PRICE_CORE resolves to a different price — a stale CORE wins over PRICE_ID.');
    }

    // 2 ── THE TARGET PRICE, RE-VERIFIED AT THE MOMENT OF THE WRITE. An earlier read is evidence
    // about an earlier moment; a price can be edited between then and now.
    const price: any = await stripe.prices.retrieve(TO_PRICE);
    const priceOk = price.active === true && price.currency === EXPECT.currency
      && price.unit_amount === EXPECT.unit_amount && price.tax_behavior === EXPECT.tax_behavior;
    if (!add('target price is active gbp 7500 inclusive', priceOk,
      `active=${price.active} ${price.currency} ${price.unit_amount} ${price.tax_behavior}`)) {
      return refuse('The target price is not what this migration was written for.');
    }

    // 3 ── THE SUBSCRIPTION'S SHAPE. Anything unexpected means something else has changed it, and
    // this endpoint's assumptions no longer hold.
    const before: any = await stripe.subscriptions.retrieve(SUB_ID);
    const items = before.items?.data ?? [];
    if (!add('exactly one line item', items.length === 1, `${items.length} item(s)`)) {
      return refuse('The subscription does not have exactly one line item.');
    }
    const item = items[0];
    const currentPrice = typeof item.price === 'string' ? item.price : item.price?.id;

    // IDEMPOTENT: already migrated is a success, not a refusal.
    if (currentPrice === TO_PRICE) {
      add('already on the target price', true, TO_PRICE);
      return res.status(200).json({ ok: true, dryRun, alreadyMigrated: true, message: 'Already on the new price — nothing to do.', checks });
    }
    if (!add('item id is the expected one', item.id === ITEM_ID, item.id)) {
      return refuse('The line item id is not the one this migration targets.');
    }
    if (!add('item is on the OLD price', currentPrice === FROM_PRICE, String(currentPrice))) {
      return refuse('The line item is on neither the old nor the new price.');
    }

    const snapshot = {
      status: before.status,
      trial_end: iso(before.trial_end),
      quantity: item.quantity,
      price: currentPrice,
      item_id: item.id,
      currency: before.currency,
      cancel_at_period_end: before.cancel_at_period_end,
    };

    if (dryRun) {
      return res.status(200).json({
        ok: true, dryRun: true, checks, before: snapshot,
        wouldSend: {
          subscription: SUB_ID,
          items: [{ id: ITEM_ID, price: TO_PRICE, quantity: item.quantity }],
          proration_behavior: 'none',
        },
        note: 'Nothing was written. trial_end will be re-read after the real call and compared, not assumed.',
      });
    }

    // ── THE WRITE ────────────────────────────────────────────────────────────────────────────────
    // proration_behavior 'none': the subscription is trialing, so there is nothing to prorate, and
    // an unexpected proration invoice on a tenant who was promised a free period is precisely the
    // surprise worth ruling out rather than reasoning about.
    await stripe.subscriptions.update(
      SUB_ID,
      { items: [{ id: ITEM_ID, price: TO_PRICE, quantity: item.quantity }], proration_behavior: 'none' },
      { idempotencyKey: `price-migration:${SUB_ID}:${TO_PRICE}` },
    );

    // ── RE-READ AND COMPARE. Nothing below is assumed from the request. ─────────────────────────
    const after: any = await stripe.subscriptions.retrieve(SUB_ID);
    const aItems = after.items?.data ?? [];
    const aItem = aItems[0];
    const result = {
      status: after.status,
      trial_end: iso(after.trial_end),
      quantity: aItem?.quantity,
      price: typeof aItem?.price === 'string' ? aItem.price : aItem?.price?.id,
      item_id: aItem?.id,
      itemCount: aItems.length,
    };
    const verdicts = {
      trialPreserved: result.trial_end === snapshot.trial_end,
      itemReplacedNotAppended: aItems.length === 1 && result.item_id === ITEM_ID,
      priceIsNew: result.price === TO_PRICE,
      quantityUnchanged: result.quantity === snapshot.quantity,
      statusUnchanged: result.status === snapshot.status,
    };

    await prisma.superAdminAudit.create({
      data: {
        operator_user_id: actor.userId,
        action: 'billing.price_migrated',
        target_group_id: (await prisma.groupBilling.findFirst({ where: { stripe_subscription_id: SUB_ID }, select: { group_id: true } }))?.group_id ?? null,
        target_operator_id: null,
        target_name_snapshot: SUB_ID,
        reason: `Moved from ${FROM_PRICE} (exclusive) to ${TO_PRICE} (inclusive) per Terms v2.`,
        detail: { before: snapshot, after: result, verdicts } as any,
      },
    }).catch(() => {});

    return res.status(200).json({ ok: true, dryRun: false, checks, before: snapshot, after: result, verdicts });
  } catch (e: any) {
    return res.status(502).json({ ok: false, dryRun, message: 'Stripe call failed', detail: String(e?.message ?? e).slice(0, 400), checks });
  }
}
