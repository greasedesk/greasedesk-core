/**
 * File: pages/api/stripe/change-plan.ts
 * SWITCH BETWEEN MONTHLY AND ANNUAL — DURING THE TRIAL ONLY (owner, 2026-10-28). ADMIN-only.
 *
 * ── WHY THE TRIAL IS THE WHOLE WINDOW ──────────────────────────────────────────────────────────
 * Before the first charge there is no money to move: no invoice has been raised, nothing has been
 * collected, and there is nothing to prorate. That is what makes this endpoint simple enough to
 * be safe — it swaps the subscription item and stamps the new shape, and the existing webhook
 * path records the rest. After the first charge a switch is a credit note, a proration and a
 * refund policy, and it is OUT OF SCOPE: this refuses rather than guessing at one.
 *
 * `proration_behavior: 'none'` is stated rather than relied upon. Stripe's default for a trialing
 * subscription would not prorate either, but a default is a thing that can change under us, and
 * the one guarantee being made to the garage is "no money moves".
 *
 * The PRICE is resolved server-side by offerFor, exactly as at checkout — the body chooses a
 * SHAPE, never an amount and never an entitlement to the offer.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { refuseDemoBilling } from '@/lib/demo-tenant';
import { getStripe, stripePriceId } from '@/lib/stripe';
import { planFor, planSettings, subscriptionLineFor, renewalAnnualPennies, type PlanKind } from '@/lib/billing-plans';
import { offerFor } from '@/lib/affiliate';
import { coreProductId } from '@/lib/modules';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;
  if (!groupId) return res.status(400).json({ message: 'No group in scope.' });
  if (await refuseDemoBilling(res, groupId)) return;

  const want = (req.body as { plan?: unknown } | undefined)?.plan;
  if (want !== 'monthly' && want !== 'annual') {
    return res.status(400).json({ message: 'Choose either the monthly or the annual plan.' });
  }

  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ message: 'Billing isn’t configured yet.' });

  const [group, billing] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, country_code: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { stripe_subscription_id: true, subscription_status: true } }),
  ]);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  if (!billing?.stripe_subscription_id) {
    return res.status(409).json({ message: 'There is no subscription to change yet — choose a plan at checkout.' });
  }

  // ── TRIALING, READ FROM STRIPE, NOT FROM THE CACHE ──────────────────────────────────────────
  // The cache is Stripe's truth as of the last webhook. The question here is "has the first
  // charge happened", and acting on a cached `trialing` that went `active` ten minutes ago would
  // switch a plan somebody has already paid for. One retrieve, and it is the authoritative answer.
  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
  } catch (e: any) {
    console.error('[stripe] change-plan: subscription retrieve failed —', e?.message);
    return res.status(502).json({ message: 'Could not read your subscription — please try again shortly.' });
  }
  if (sub.status !== 'trialing') {
    return res.status(409).json({
      message: 'Your plan can be changed during the free trial. After the first payment, please contact us and we will sort it out.',
      code: 'TRIAL_OVER',
    });
  }

  const profile = resolveTenantProfile(group);
  const currency = profile.currency.toLowerCase();
  const settings = await planSettings(prisma, { country: group.country_code });
  const quantity = Math.max(1, (sub.items?.data ?? []).reduce((n, i) => n + (i.quantity ?? 1), 0));

  const offer = want === 'annual' ? await offerFor(prisma, groupId) : null;
  const planKind: PlanKind = want === 'annual' ? offer!.plan : 'monthly';
  const plan = planFor(planKind, settings, quantity);

  let coreProduct: string | null = null;
  if (want === 'annual') {
    coreProduct = await coreProductId();
    if (!coreProduct) return res.status(503).json({ message: 'Annual billing is being set up — please try again shortly.' });
  }

  const item = sub.items?.data?.[0];
  if (!item) return res.status(409).json({ message: 'Your subscription has no plan line to change.' });

  const line = subscriptionLineFor(plan, {
    monthlyPriceId: stripePriceId(), coreProductId: coreProduct,
    renewalPennies: renewalAnnualPennies(settings), currency, quantity,
  });

  try {
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, ...(line as any), quantity }],
      proration_behavior: 'none',   // stated, not inherited — see the file header
      // The trial end is NOT touched. Switching plan must not move the date the garage was told
      // it would be charged; it changes only what it is charged.
      trial_end: (sub as any).trial_end ?? undefined,
      metadata: { ...(sub.metadata ?? {}), gd_plan: planKind },
    });
  } catch (e: any) {
    console.error('[stripe] change-plan: update failed —', e?.message);
    await writeAudit(prisma as any, {
      groupId, userId: vis.userId ?? null,
      action: 'billing.plan_change_failed', entity: 'group', entityId: groupId,
      diff: { wanted: planKind, detail: String(e?.message ?? '').slice(0, 200) },
    }).catch(() => {});
    return res.status(502).json({ message: 'Could not change your plan — please try again shortly.' });
  }

  // The TenantPlanTerms row is appended by the webhook from the metadata stamped above, so the
  // timeline is written from Stripe's object rather than from this request's intention.
  await writeAudit(prisma as any, {
    groupId, userId: vis.userId ?? null,
    action: 'billing.plan_changed', entity: 'group', entityId: groupId,
    diff: { to: planKind, amountPennies: plan.payNowPennies || null, trialEnd: (sub as any).trial_end ?? null },
  }).catch(() => {});

  return res.status(200).json({
    ok: true, plan: planKind,
    chargedPennies: plan.payNowPennies || null,
    discountPennies: offer?.discountPennies ?? 0,
  });
}
