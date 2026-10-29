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
 *
 * ── AND THE SECOND DOOR: THE LAST FOURTEEN DAYS (owner ruling, 2026-10-29) ─────────────────────
 * "After the first charge it is out of scope" left a garage that had paid for a year with no way to
 * be on monthly the FOLLOWING year except by writing to us and being remembered. So there is now
 * one more window: inside the last fourteen days before renewal a paid annual garage may choose
 * monthly, and it takes effect AT RENEWAL. The year already paid for is never shortened and never
 * refunded — which is what makes this window as safe as the trial one: the period being changed is
 * one nobody has paid for yet.
 *
 * STRIPE HOLDS IT, not us (see lib/plan-hold for why), as a subscription schedule whose first phase
 * is the paid year exactly as it stands and whose second is monthly from the renewal date. Undoing
 * it is releasing the schedule. Nothing of ours is written until the day it becomes true, so this
 * endpoint cannot leave the licences screen claiming a plan the garage is not yet on.
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
import { monthlySwitchWindow, pendingScheduleId, renewalAtFor, WINDOW_DAYS } from '@/lib/renewal-window';
import { monthlyAtRenewalUpdate, holdFidelity } from '@/lib/plan-hold';
import { renewalAtOf } from '@/lib/stripe-period';
import { coreProductId } from '@/lib/modules';
import { resolveTenantProfile, formatProfileDate } from '@/lib/locale-profiles';
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
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { stripe_subscription_id: true, subscription_status: true, first_paid_at: true, current_period_end: true } }),
    currentPlanTerms(prisma, groupId),
  ]);
  if (!group) return res.status(404).json({ message: 'Group not found.' });
  if (!billing?.stripe_subscription_id) {
    return res.status(409).json({ message: 'There is no subscription to change yet — choose a plan at checkout.' });
  }

  // ── READ STRIPE FIRST. EVERY DECISION BELOW IS ITS ANSWER, NOT THE CACHE'S ──────────────────
  // The cache is Stripe's truth as of the last webhook. "Has the first charge happened", "when
  // does it renew" and "is a move already held" are all questions a cached row can be a month
  // behind on, and each one decides whether money moves. One retrieve, before anything branches.
  //
  // AND A SUBSCRIPTION WE CANNOT READ IS NOT AN ERROR EVERYWHERE. For a garage that has paid for a
  // year and is asking for monthly, an unreadable subscription means an UNKNOWN renewal date, and
  // an unknown renewal date leaves the window shut (lib/renewal-window) — so the honest answer is
  // the undated refusal below, not a 502 telling a garage to try again at something that will keep
  // refusing. Every other path genuinely needs the object and says so.
  let sub = null as Awaited<ReturnType<typeof stripe.subscriptions.retrieve>> | null;
  try {
    sub = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
  } catch (e: any) {
    console.error('[stripe] change-plan: subscription retrieve failed —', e?.message);
  }

  const profile = resolveTenantProfile(group);
  const dateLabel = (d: Date) => formatProfileDate(profile, d, { long: true });
  // ONE RESOLUTION, shared with the licences screen: live first, the cache as the fallback. Were
  // this the live read alone, a Stripe outage would have the screen offering a switch (from the
  // cache) that this endpoint refused as unknown — the two readers disagreeing about one rule,
  // which is the failure the shared predicate exists to prevent.
  const renewalAt = renewalAtFor({ live: sub ? renewalAtOf(sub) : null, cached: billing.current_period_end, now: new Date() });
  const heldSchedule = sub ? pendingScheduleId(sub) : null;
  const paidAnnual = annualPaidIn({ plan: (tail?.plan ?? null) as PlanKind | null, firstPaidAt: billing.first_paid_at });

  // ── A HELD MOVE IS UNDONE BY RELEASING THE SCHEDULE ─────────────────────────────────────────
  // FIRST, because a subscription managed by a schedule refuses subscriptions.update: every path
  // below would fail at Stripe with a message no garage should have to read. We attach a schedule
  // for exactly one reason, so its presence IS "monthly is already held" (lib/renewal-window).
  if (heldSchedule) {
    if (want === 'annual') {
      try {
        await stripe.subscriptionSchedules.release(heldSchedule);
      } catch (e: any) {
        console.error('[stripe] change-plan: schedule release failed —', e?.message);
        return res.status(502).json({ message: 'Could not change your plan back — please try again shortly.' });
      }
      await writeAudit(prisma as any, {
        groupId, userId: vis.userId ?? null,
        action: 'billing.plan_hold_released', entity: 'group', entityId: groupId,
        diff: { scheduleId: heldSchedule, renewalAt: renewalAt?.toISOString() ?? null },
      }).catch(() => {});
      // NO TERMS ROW, in either direction. Nothing was ever written when the move was held, so
      // there is nothing to unwrite: the garage is on the plan the timeline already says it is on.
      return res.status(200).json({ ok: true, plan: 'annual', released: true });
    }
    return res.status(409).json({
      message: renewalAt
        ? `You’ve already asked to move to monthly on ${dateLabel(renewalAt)}.`
        : 'You’ve already asked to move to monthly at your renewal.',
      code: 'ALREADY_PENDING',
    });
  }

  // ── A PAID YEAR IS NOT GIVEN BACK A MONTH AT A TIME — EXCEPT IN THE LAST FOURTEEN DAYS ──────
  // BEFORE the trialing check, because this refusal is the true one and the generic "after the
  // first payment, contact us" would send a garage that cannot be helped to a support queue.
  // The licences screen decides what to show on the SAME two predicates, so a screen offering a
  // switch and an endpoint refusing it cannot disagree.
  if (want === 'monthly' && paidAnnual) {
    const win = monthlySwitchWindow({ renewalAt, now: new Date() });
    if (!win.open) {
      return res.status(409).json({
        // THE DATE, when we have one. "At renewal rather than now" was true and unactionable; a
        // garage reading it had no idea when to come back. An unknown renewal date says less
        // rather than guessing — see lib/renewal-window on why unknown is closed.
        message: win.opensAt && renewalAt
          ? `You’ve paid for a full year. You can change to monthly from ${dateLabel(win.opensAt)}, the last ${WINDOW_DAYS} days before your renewal on ${dateLabel(renewalAt)}.`
          : `You’ve paid for a full year. You can change to monthly in the last ${WINDOW_DAYS} days before your renewal.`,
        code: 'ANNUAL_PAID',
        ...(win.opensAt ? { opensAt: win.opensAt.toISOString() } : {}),
        ...(renewalAt ? { renewalAt: renewalAt.toISOString() } : {}),
      });
    }

    // The window can only be open when a renewal date was read, and only a retrieved subscription
    // carries one — so this is unreachable. Stated rather than asserted away with a cast: a cast
    // is where the compiler stops checking, and the field that started today's work was hidden
    // behind exactly one of those.
    if (!sub) return res.status(502).json({ message: 'Could not read your subscription — please try again shortly.' });

    const monthlyPriceId = stripePriceId();
    if (!monthlyPriceId) return res.status(503).json({ message: 'Monthly billing isn’t configured yet.' });
    const sites = Math.max(1, (sub.items?.data ?? []).reduce((n, i) => n + (i.quantity ?? 1), 0));
    const before = {
      priceIds: (sub.items?.data ?? []).map((i) => (typeof i.price === 'string' ? i.price : i.price?.id)).filter((x): x is string => !!x),
      totalQuantity: sites,
      periodEnd: renewalAt ? Math.floor(renewalAt.getTime() / 1000) : null,
    };

    let schedule;
    try {
      schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    } catch (e: any) {
      console.error('[stripe] change-plan: schedule create failed —', e?.message);
      return res.status(502).json({ message: 'Could not arrange the change — please try again shortly.' });
    }

    const built = monthlyAtRenewalUpdate({ phase: (schedule.phases?.[0] ?? {}) as any, monthlyPriceId, quantity: sites });
    if (!built.ok) {
      // REFUSED RATHER THAN DROPPED. Sending phase 1 back without a field it carries resets that
      // field on the year the garage has already paid for. Release first: the schedule as created
      // mirrors the subscription, so letting go of it leaves nothing changed.
      await stripe.subscriptionSchedules.release(schedule.id).catch(() => {});
      console.error('[stripe] change-plan: phase carries fields this build cannot echo —', built.unknownFields.join(', '));
      await writeAudit(prisma as any, {
        groupId, userId: vis.userId ?? null,
        action: 'billing.plan_hold_refused', entity: 'group', entityId: groupId,
        diff: { unknownFields: built.unknownFields, scheduleId: schedule.id },
      }).catch(() => {});
      return res.status(502).json({ message: 'Could not arrange the change — please contact us and we will sort it out.' });
    }

    let updated;
    try {
      updated = await stripe.subscriptionSchedules.update(schedule.id, built.params);
    } catch (e: any) {
      await stripe.subscriptionSchedules.release(schedule.id).catch(() => {});
      console.error('[stripe] change-plan: schedule update failed —', e?.message);
      await writeAudit(prisma as any, {
        groupId, userId: vis.userId ?? null,
        action: 'billing.plan_hold_failed', entity: 'group', entityId: groupId,
        diff: { detail: String(e?.message ?? '').slice(0, 200), scheduleId: schedule.id },
      }).catch(() => {});
      return res.status(502).json({ message: 'Could not arrange the change — please try again shortly.' });
    }

    // ── DID THE PAID YEAR COME OUT UNTOUCHED? ─────────────────────────────────────────────────
    // Updating the CURRENT phase applies to the live subscription, so an echo that moved end_date
    // would shorten a year that has been paid for. No automatic repair: releasing does not undo a
    // bad update, and a correcting write to a state we have just proved we misread is worse than
    // stopping. This shouts and refuses.
    const fid = holdFidelity({ before, phase: (updated.phases?.[0] ?? {}) as any });
    if (!fid.ok) {
      console.error('[stripe] change-plan: PHASE 1 CHANGED —', fid.differences.join('; '));
      await writeAudit(prisma as any, {
        groupId, userId: vis.userId ?? null,
        action: 'billing.plan_hold_damaged', entity: 'group', entityId: groupId,
        diff: { differences: fid.differences, scheduleId: schedule.id, subscriptionId: sub.id },
      }).catch(() => {});
      return res.status(502).json({ message: 'Something went wrong arranging the change — please contact us before trying again.' });
    }

    await writeAudit(prisma as any, {
      groupId, userId: vis.userId ?? null,
      action: 'billing.plan_hold_set', entity: 'group', entityId: groupId,
      diff: { to: 'monthly', effectiveAt: renewalAt?.toISOString() ?? null, scheduleId: schedule.id, sites },
    }).catch(() => {});

    // NO TERMS ROW NOW. The garage is still on the yearly plan today; phase 2 carries
    // `gd_plan: monthly` in its metadata, so the existing webhook path appends the row on the day
    // it becomes true. Writing it here would put the D1 lie back, fourteen days long.
    return res.status(200).json({
      ok: true, plan: 'monthly', held: true,
      effectiveAt: renewalAt?.toISOString() ?? null,
      effectiveLabel: renewalAt ? dateLabel(renewalAt) : null,
    });
  }

  // EVERY PATH FROM HERE NEEDS THE OBJECT. The one question answerable without it is above.
  if (!sub) return res.status(502).json({ message: 'Could not read your subscription — please try again shortly.' });

  if (sub.status !== 'trialing') {
    return res.status(409).json({
      message: 'Your plan can be changed during the free trial. After the first payment, please contact us and we will sort it out.',
      code: 'TRIAL_OVER',
    });
  }

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
