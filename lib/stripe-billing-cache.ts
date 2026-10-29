/**
 * File: lib/stripe-billing-cache.ts
 * THE one place a Stripe Subscription is projected onto the GroupBilling cache (item-12/13).
 * Shared by the async webhook (post-onboarding: renew/cancel/card-fail) AND the synchronous
 * onboarding confirm (checkout return). Both write Stripe's CURRENT truth, so the write is
 * idempotent — a webhook that lands after the confirm is a no-op, and a confirm that beats the
 * webhook simply lets the paid tenant through without waiting at a spinner.
 *
 * IMPORTANT distinction from "the redirect writes nothing": we NEVER trust the redirect's query
 * params. The subscription object here comes from an authenticated server-side Stripe API call
 * (webhook-verified event, or stripe.checkout.sessions/subscriptions.retrieve) — that IS Stripe's
 * truth, not the untrusted browser round-trip.
 *
 * Also mirrors Stripe's trial_end onto Group.trial_ends_at so Stripe owns the trial clock — the
 * local signup timestamp is no longer the source of truth (item-13).
 */
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { billingStatusFromStripe } from '@/lib/billing';
import { modulesFromProducts, coreProductId, applyStripeModules } from '@/lib/modules';
import { clearFree, isLiveSubscription } from '@/lib/free-tenant';

/**
 * THE PRODUCTS A SUBSCRIPTION IS FOR. Exported because it is the step entitlement turns on, and a
 * clause asserting "monthly and annual give the same access" has to run the REAL extraction over
 * two real subscription shapes — comparing modulesFromProducts([core]) with itself passes against
 * any implementation, including one that entitles nobody.
 *
 * A line item whose price arrived as a bare string carries no product at all, so it contributes
 * nothing rather than being guessed at. `price.product` is a plain id on the subscription objects
 * Stripe sends, so this needs no expansion and no second API call.
 */
export function productsOfSubscription(sub: Stripe.Subscription): string[] {
  return (sub.items?.data ?? [])
    .map((i) => (typeof i.price === 'string'
      ? null
      : (typeof i.price?.product === 'string' ? i.price.product : i.price?.product?.id ?? null)))
    .filter((x): x is string => !!x);
}

/** Map a Stripe subscription onto GroupBilling (+ the trial clock on Group). Resolves the tenant by
 *  customer id, falling back to an explicit groupId (first confirm, before the customer is cached). */
export async function applyStripeSubscriptionToCache(sub: Stripe.Subscription, fallbackGroupId?: string | null): Promise<string | null> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const byCustomer = customerId
    ? await prisma.groupBilling.findFirst({ where: { stripe_customer_id: customerId }, select: { group_id: true } })
    : null;
  const groupId = byCustomer?.group_id ?? fallbackGroupId ?? null;
  if (!groupId) return null;

  const periodEnd = (sub as any).current_period_end ? new Date((sub as any).current_period_end * 1000) : null;
  const trialEnd = (sub as any).trial_end ? new Date((sub as any).trial_end * 1000) : null;

  // ENTITLEMENT IS DERIVED HERE, from the SAME subscription object, in the SAME transaction as the
  // billing status — that is what makes "the price they pay" and "the modules they get" incapable of
  // drifting. Per-module line items: each item's PRODUCT maps 1:1 to a module key (lib/modules).
  //
  // THE PRODUCT, NOT THE PRICE (2026-10-28). Annual is an inline price_data amount derived from the
  // Engine Room settings, so its Price id is generated and in no map; the old price-based lookup
  // answered that with no modules at all — a garage paying for Core and entitled to nothing. Both
  // intervals are prices OF THE SAME PRODUCT, which is exactly why they give identical access.
  //
  // `price.product` is a plain id on the subscription objects Stripe sends, so this needs no
  // expansion and no second API call. A line item whose price arrived as a bare string carries no
  // product at all — it contributes nothing rather than being guessed at.
  const entitled = modulesFromProducts(productsOfSubscription(sub), await coreProductId());

  // Read the anchor BEFORE writing: "written once, never overwritten while non-null" needs to know
  // whether one is already there.
  const existing = await prisma.groupBilling.findUnique({
    where: { group_id: groupId }, select: { grace_started_at: true, subscription_status: true },
  });
  // ── IS THIS TENANT MARKED FREE? ─────────────────────────────────────────────────────────────
  // Read here, beside the grace anchor, because the answer is needed inside the transaction below
  // and this read already exists. See the reconciliation at the end of that transaction.
  const freeNow = (await prisma.group.findUnique({
    where: { id: groupId }, select: { free_since: true },
  })) as { free_since: Date | null } | null;

  await prisma.$transaction(async (tx: any) => {
    await tx.groupBilling.update({
      where: { group_id: groupId },
      data: {
        stripe_customer_id: customerId ?? undefined,
        stripe_subscription_id: sub.id,
        subscription_status: sub.status,
        current_period_end: periodEnd,
        status: billingStatusFromStripe(sub.status), // coarse projection for display
        // ── THE GRACE ANCHOR: written ONCE, on the transition INTO past_due, and never again while
        // non-null. Stripe fires subscription.updated on every retry; overwriting here would push
        // the countdown forward each time and the tenant would never restrict.
        // Anchored on past_due rather than the first invoice.payment_failed (ruling 2026-08-06): a
        // single decline is often transient, and a seven-day countdown that appears and vanishes is
        // worse than none.
        ...(sub.status === 'past_due' && !existing?.grace_started_at
          ? { grace_started_at: new Date(), grace_reason: trialEnd || existing?.subscription_status === 'trialing' ? 'trial_ended' : 'payment_failed' }
          : {}),
        // Recovered: the money arrived. Clear the anchor so a LATER failure starts a fresh clock.
        ...(sub.status === 'active' || sub.status === 'trialing' ? { grace_started_at: null, grace_reason: null } : {}),
      },
    });
    await applyStripeModules(tx as any, groupId, entitled);

    // ── A LIVE SUBSCRIPTION OVERTAKES A FREE DECISION ─────────────────────────────────────────
    // GB-GD1967 was set free on 5 September and took a real subscription on the 6th. Nothing
    // noticed, and the contradiction broke two things quietly: the tenant was refused its own
    // Stripe portal, and the dashboard banner went silent about a charge that was coming.
    //
    // Stripe's truth wins because it is the money — a live subscription is a card actually being
    // charged, while free_since is a note we wrote about a tenant. So this reconciles rather than
    // refuses: a webhook has nowhere to refuse TO. It either 500s and Stripe retries forever, or it
    // logs and carries on, which is a refusal nobody receives.
    //
    // IN THIS TRANSACTION, deliberately. If the subscription write commits and the clear does not,
    // the contradiction is back and nothing will look again.
    //
    // Only LIVE statuses: a canceled or incomplete subscription overtakes nothing. And only
    // free_since — is_demo and is_internal answer different questions, and a demo that acquires a
    // subscription is a bug to shout about, not a flag to quietly reconcile.
    if (freeNow?.free_since && isLiveSubscription(sub.status)) {
      await clearFree({
        groupId,
        operatorUserId: null, // nobody acted; the platform reconciled it. See the schema comment.
        reason: `Free decision overtaken by a live Stripe subscription (${sub.status}). Cleared automatically when the subscription was cached.`,
        detail: { stripeSubscriptionId: sub.id, stripeStatus: sub.status, via: 'stripe-billing-cache' },
      }, tx as any);
    }
  });

  // Stripe owns the trial clock once a subscription exists (item-13): mirror trial_end onto Group.
  if (trialEnd) {
    await prisma.group.update({ where: { id: groupId }, data: { trial_ends_at: trialEnd } }).catch(() => {});
  }

  // ── THE PLAN SHAPE, APPENDED FROM STRIPE'S OWN OBJECT ───────────────────────────────────────
  // Checkout and the plan-switch endpoint both stamp `gd_plan` on the subscription's metadata, so
  // the shape travels with the money instead of beside it. Appending HERE rather than at checkout
  // means an abandoned session writes nothing, a replayed webhook writes nothing twice, and a
  // switch during the trial appends its own row — all from the same line.
  //
  // APPEND-ONLY and only on a CHANGE: TenantPlanTerms is a timeline, so re-writing the same shape
  // on every subscription.updated would bury the one row that says what they signed up under
  // under hundreds that say nothing new.
  //
  // THE COMPARE USED TO BE HERE, and that is exactly how GB-GD2491 got two identical rows: this
  // handler runs for `checkout.session.completed` AND `customer.subscription.created`, they
  // arrived 168ms apart, both read `monthly` and both wrote. Reading then writing with nothing in
  // between is not a check. writePlanTerms now does the compare itself, under a lock on the
  // garage's Group row, so the second caller blocks and then finds nothing to do. Deciding here
  // whether to call it would put the race straight back.
  const shape = (sub.metadata as Record<string, string> | null)?.gd_plan;
  if (shape) {
    try {
      const { planSettings, writePlanTerms } = await import('@/lib/billing-plans');
      const { planForGarage } = await import('@/lib/affiliate');
      const group = await prisma.group.findUnique({ where: { id: groupId }, select: { country_code: true } });
      const sites = Math.max(1, (sub.items?.data ?? []).reduce((n, i) => n + (i.quantity ?? 1), 0));
      const settings = await planSettings(prisma, { country: group?.country_code });
      // FROZEN-AWARE (2026-10-29). This called planFor with TODAY's settings, so checkout C
      // recorded `paid_now_pennies 60000 / months_paid 8` for a garage Stripe was charging £450
      // under a six-month freeze: the document of what was agreed contradicting the money.
      const { plan } = await planForGarage(prisma, groupId, shape as any, { settings, sites });
      await writePlanTerms(prisma, groupId, plan);
    } catch (e: any) {
      // NON-FATAL, and loudly so. The billing cache is what decides access; the terms row is the
      // record of what was agreed. Losing the second must never cost the tenant the first.
      console.error(`[billing-cache] could not append plan terms (${shape}) for ${groupId} —`, e?.message);
    }
  }

  return groupId;
}

// ── THE FIRST MONEY, RECORDED ONCE (owner ruling, 2026-10-29) ───────────────────────────────────
// "Is this a new garage?" used to be answered by "has a subscription ever reached trialing", which
// made the affiliate offer depend on which button was pressed at signup rather than on whether we
// had ever been paid. The ruling is that the offer survives a switch during the trial, so the
// question has to be the real one — and nothing in this database answered it. The commission
// accrual is the nearest thing and is about a REP: it writes nothing when there is no attribution
// and writes zero during the trial, so reading it would be reading a different subject.
//
// A £0 trial invoice is NOT a payment. That is the whole distinction the ruling turns on, so it is
// the first thing this checks.
const unixToDateC = (s: number | null | undefined): Date | null => (s ? new Date(s * 1000) : null);
const idOfC = (v: string | { id: string } | null | undefined): string | null =>
  (typeof v === 'string' ? v : v?.id) ?? null;

export type FirstPaymentResult = 'recorded' | 'already recorded' | 'not a payment' | 'unknown customer';

/**
 * Stamp GroupBilling.first_paid_at the first time a non-zero invoice is paid. WRITTEN ONCE and
 * never overwritten: this is the date we were FIRST paid, so a later invoice must not move it.
 * Idempotent, so a re-delivered webhook is a no-op.
 */
export async function recordFirstPayment(db: typeof prisma, invoice: Stripe.Invoice): Promise<FirstPaymentResult> {
  const inv = invoice as any;
  const amountPaid: number = inv.amount_paid ?? 0;
  if (amountPaid <= 0) return 'not a payment';

  const customerId = idOfC(inv.customer);
  if (!customerId) return 'unknown customer';
  const billing = await db.groupBilling.findUnique({
    where: { stripe_customer_id: customerId },
    select: { group_id: true, first_paid_at: true },
  });
  if (!billing) return 'unknown customer';
  if (billing.first_paid_at) return 'already recorded';

  const paidAt = unixToDateC(inv.status_transitions?.paid_at) ?? unixToDateC(inv.created) ?? new Date();
  await db.groupBilling.update({ where: { group_id: billing.group_id }, data: { first_paid_at: paidAt } });
  return 'recorded';
}
