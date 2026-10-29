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
import { planSettings, subscriptionLineFor, renewalAnnualPennies, annualPaidIn, currentPlanTerms, writePlanTerms, type PlanKind } from '@/lib/billing-plans';
import { offerFor, planForGarage } from '@/lib/affiliate';
import { ensureFirstYearCoupon } from '@/lib/first-year-coupon';
import { planSwitchParams } from '@/lib/plan-switch';
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

  const [group, billing, tail] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, country_code: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { stripe_subscription_id: true, subscription_status: true, first_paid_at: true } }),
    currentPlanTerms(prisma, groupId),
  ]);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  if (!billing?.stripe_subscription_id) {
    return res.status(409).json({ message: 'There is no subscription to change yet — choose a plan at checkout.' });
  }

  // ── A PAID YEAR IS NOT GIVEN BACK A MONTH AT A TIME (owner, 2026-10-29) ─────────────────────
  // BEFORE the trialing check, because this refusal is the true one and the generic "after the
  // first payment, contact us" would send a garage that cannot be helped to a support queue.
  // The licences screen hides the control on the same predicate; this is the half that holds when
  // the screen is out of date, old, or bypassed altogether.
  if (want === 'monthly' && annualPaidIn({ plan: (tail?.plan ?? null) as PlanKind | null, firstPaidAt: billing.first_paid_at })) {
    return res.status(409).json({
      message: 'You’ve paid for a full year, so the plan can be changed at renewal rather than now.',
      code: 'ANNUAL_PAID',
    });
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

  // The settings this request already read — one read per request (owner, 2026-10-29).
  const offer = want === 'annual' ? await offerFor(prisma, groupId, { settings }) : null;
  const planKind: PlanKind = want === 'annual' ? offer!.plan : 'monthly';
  // FROZEN-AWARE (2026-10-29). This read planFor(planKind, settings) — today's settings — so a
  // garage whose offer was frozen at six months was told, and audited at, the live figure.
  const { plan } = await planForGarage(prisma, groupId, planKind, { settings, sites: quantity, offer: offer ?? undefined });

  // ── THE COUPON MOVES WITH THE PLAN, IN BOTH DIRECTIONS (owner ruling, 2026-10-29) ────────────
  // Attaching it was simply missing: change-plan resolved the offer, reported discountPennies in
  // its JSON, and never told Stripe — so a garage quoted £450 on the licences screen would have
  // been charged £750 at trial end. REMOVING it matters just as much and is easier to miss: a
  // duration:'once' coupon left on a subscription that has switched to MONTHLY comes off the
  // first £75 invoice instead, which is the offer being spent on a month.
  let couponId: string | null = null;
  if (want === 'annual' && offer && offer.discountPennies > 0) {
    couponId = await ensureFirstYearCoupon(stripe, offer.discountPennies, currency);
    if (!couponId) return res.status(503).json({ message: 'The referral offer is being set up — please try again shortly.' });
  }

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
    // BUILT IN lib/plan-switch, where a gate can read the object without calling Stripe. The
    // trial end is carried through untouched: a switch changes what a garage is charged, never
    // the date it was told it would be charged.
    await stripe.subscriptions.update(sub.id, planSwitchParams({
      itemId: item.id, line: line as any, quantity,
      trialEnd: (sub as any).trial_end,
      metadata: { ...(sub.metadata ?? {}), gd_plan: planKind },
      couponId,
    }));
  } catch (e: any) {
    console.error('[stripe] change-plan: update failed —', e?.message);
    await writeAudit(prisma as any, {
      groupId, userId: vis.userId ?? null,
      action: 'billing.plan_change_failed', entity: 'group', entityId: groupId,
      diff: { wanted: planKind, detail: String(e?.message ?? '').slice(0, 200) },
    }).catch(() => {});
    return res.status(502).json({ message: 'Could not change your plan — please try again shortly.' });
  }

  // ── THE TIMELINE IS WRITTEN HERE TOO, NOT ONLY BY THE WEBHOOK (D1, 2026-10-29) ──────────────
  // It used to be the webhook's job alone, "so the timeline is written from Stripe's object
  // rather than from this request's intention". That reads well and left the screen lying: the
  // licences page reads the current plan off the tail of this timeline, the browser reloads the
  // instant this handler returns, and the webhook arrives a second or so later. A garage that had
  // just switched to monthly was told it was still on the yearly plan, and stayed told until it
  // reloaded again. The reader and the writer were on different clocks.
  //
  // Safe to write from both ends because writePlanTerms is the locked chokepoint: it takes the
  // group row, re-reads the tail inside the transaction, and inserts ONLY on a change. Whichever
  // of the two arrives second finds its own row already there and writes nothing.
  await writePlanTerms(prisma, groupId, plan).catch((e: any) => {
    // Not fatal: Stripe has the change, and the webhook will append the row on its own. Said out
    // loud because until it does, the screen is a step behind.
    console.error('[stripe] change-plan: plan terms write failed —', e?.message);
  });

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
