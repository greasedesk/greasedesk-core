/**
 * File: pages/admin/settings/licences.tsx
 * Settings → Licence & Subscriptions. Shows the subscription (Stripe cache) + billable location
 * count, and hosts the two hosted-Stripe actions: Start subscription (Checkout) and Manage billing
 * (Billing Portal — card, plan changes, cancellation all live there; we build no bespoke cancel).
 * A LAPSED tenant sees the read-only guarantee loudly.
 *
 * ── A DEMO IS NOT A DEFICIENT REAL ACCOUNT ──────────────────────────────────────────────────────
 * Rendered against a demo this page said "Status: No subscription", "Monthly £75" and offered a
 * Start subscription button. Every word of that is about a subscription the tenant cannot have and
 * must not buy: the group is deleted by the demo cron, so a card entered here would be attached to
 * something that vanishes. The endpoints refuse regardless (lib/demo-tenant), but a page offering a
 * button that always fails is its own defect — so the demo gets its own panel, with no price on it.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { monthlyPriceLabelFor, perLocationLabelFor } from '@/lib/billing-pricing';
import { resolveTenantProfile, formatProfileDate } from '@/lib/locale-profiles';
import { isLapsedStatus } from '@/lib/billing';
// Used ONLY inside getServerSideProps, so Next strips it (and lib/db behind it) from the client
// bundle. Keep it that way: a module-scope reference here would ship Prisma to the browser.
import { annualPaidIn, type PlanKind } from '@/lib/billing-plans';
import { monthlySwitchWindow, pendingScheduleId, renewalAtFor, WINDOW_DAYS } from '@/lib/renewal-window';
import { planChoiceFor, type PlanChoice } from '@/lib/plan-choice';
import PlanChooser from '@/components/billing/PlanChooser';

type PageProps = {
  groupName: string;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null; periodEndLabel: string | null;
  hasCustomer: boolean;
  siteCount: number;
  perMonthLabel: string; perLocationLbl: string;
  isDemo: boolean;
  billingConfigured: boolean;
  isAdmin: boolean;
  /** Null only for a demo, which may not buy anything. */
  choice: PlanChoice | null;
  /** What they are on NOW, from the latest TenantPlanTerms row (the webhook appends one per change). */
  currentPlan: 'monthly' | 'annual' | null;
  /** On a yearly plan with money already taken: the switch is closed outside the window below. */
  annualLocked: boolean;
  /** THE LAST FOURTEEN DAYS. Derived server-side from Stripe's own renewal date so the screen and
   *  change-plan decide on one rule (lib/renewal-window). */
  windowOpen: boolean;
  /** Formatted for the garage; null when we could not read a renewal date, which is NOT "no
   *  renewal" — it is unknown, and the copy says less rather than naming a date we guessed. */
  renewalLabel: string | null;
  windowOpensLabel: string | null;
  /** A move to monthly already held for renewal: Stripe's schedule id, read live. */
  heldForRenewal: boolean;
  windowDays: number;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 border-b border-line">
      <span className="text-muted">{label}</span>
      <span className="text-ink font-medium">{value ?? '—'}</span>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  trialing: 'Trial', active: 'Active', past_due: 'Payment retrying', canceled: 'Lapsed',
  unpaid: 'Lapsed', paused: 'Paused', incomplete: 'Awaiting payment', incomplete_expired: 'Lapsed',
};

export default function LicencesSettings(props: PageProps) {
  const { groupName, subscriptionStatus, currentPeriodEnd, periodEndLabel, hasCustomer, siteCount, perMonthLabel, perLocationLbl, billingConfigured, isAdmin, isDemo, choice, currentPlan, annualLocked, windowOpen, renewalLabel, windowOpensLabel, heldForRenewal, windowDays } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // YEARLY IS THE DEFAULT SELECTION on both doors below (owner, 2026-10-29). On the resubscribe
  // door that is simply which plan opens; on the trial switch it is also the upsell — a garage on
  // monthly lands on the yearly figures and the saving, and has to choose monthly to stay there.
  const [plan, setPlan] = useState<'monthly' | 'annual'>('annual');
  const lapsed = isLapsedStatus(subscriptionStatus); // the ONE vocabulary (lib/billing)
  const subscribed = subscriptionStatus === 'trialing' || subscriptionStatus === 'active' || subscriptionStatus === 'past_due';
  // SWITCHING IS A TRIAL-ONLY DOOR (owner, 2026-10-28). Before the first charge there is no money
  // to move; after it, a switch is a credit note and a proration and is out of scope. The control
  // is ABSENT outside the trial rather than disabled — a disabled button invites a support call
  // asking why, and change-plan would refuse it with TRIAL_OVER anyway.
  const trialing = subscriptionStatus === 'trialing';
  // THE TARGET IS WHAT THE TOGGLE IS SHOWING, not "whichever one they are not on". The block is
  // present for the whole trial so the pricing can be read either way round; the BUTTON appears
  // only when the selection differs from the plan they hold, because a button that would change
  // nothing is a support call asking what it did.
  // A PAID YEAR CLOSES THE DOOR (owner, 2026-10-29). Derived server-side by annualPaidIn, so the
  // screen and change-plan refuse on one predicate rather than two readings of the same idea.
  const canSwitch = Boolean(trialing && currentPlan && !annualLocked);
  const switchTo: 'monthly' | 'annual' | null = canSwitch && plan !== currentPlan ? plan : null;

  async function go(path: string, body?: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Could not open billing.');
      // CHECKOUT AND PORTAL HAND OFF TO STRIPE; change-plan does not. One helper, two endings,
      // decided by what came back rather than by which path was asked for.
      if (data?.url) { window.location.href = data.url; return; }
      window.location.reload();
    } catch (e: any) { setError(e?.message || 'Something went wrong.'); setBusy(false); }
  }

  if (isDemo) {
    return (
      <SettingsLayout isAdmin={isAdmin}>
        <Head><title>Licence & Subscriptions - GreaseDesk</title></Head>
        <p className="text-muted mb-6">This is a demo garage.</p>
        <div className="bg-surface border border-line rounded-xl p-6 max-w-xl">
          <Row label="Account" value={groupName} />
          <Row label="Type" value="Demo — not a subscription" />
          <Row label="Current locations" value={siteCount} />
        </div>
        <p className="text-sm text-muted mt-4 max-w-xl">
          Nothing here is billable and no card is held. Every customer, car and invoice in this
          garage is invented, and it will be deleted when the demo ends. When you want to begin with
          your own work, start a trial and you will get an empty diary of your own.
        </p>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout isAdmin={isAdmin}>
      <Head><title>Licence & Subscriptions - GreaseDesk</title></Head>
      <p className="text-muted mb-6">Your GreaseDesk subscription. Billing is {perLocationLbl} per location, per month.</p>

      {lapsed && (
        <div className="bg-warn-soft border border-warn text-warn rounded-xl p-4 max-w-xl mb-4">
          Your subscription has lapsed. <span className="font-medium">Your records are safe and fully exportable</span> — every invoice stays viewable and downloadable, forever. Resubscribe to add new work.
        </div>
      )}

      <div className="bg-surface border border-line rounded-xl p-6 max-w-xl">
        <Row label="Account" value={groupName} />
        <Row label="Status" value={subscriptionStatus ? (STATUS_LABEL[subscriptionStatus] || subscriptionStatus) : 'No subscription'} />
        <Row label="Current locations" value={siteCount} />
        <Row label="Monthly" value={perMonthLabel} />
        {currentPeriodEnd && <Row label={subscribed ? 'Renews / next charge' : 'Period end'} value={periodEndLabel ?? ''} />}
      </div>

      {error && <div className="bg-danger-soft border border-danger text-danger rounded-lg p-3 text-sm max-w-xl mt-4">{error}</div>}

      {/* THE CHOICE, on the one screen an existing garage can buy from. It used to post no body at
          all, so "Start subscription" could only ever start a monthly one. */}
      {billingConfigured && !hasCustomer && choice && (
        <div className="max-w-xl mt-4" data-testid="licence-plan-choice">
          <PlanChooser choice={choice} value={plan} onChange={setPlan} disabled={busy} />
        </div>
      )}

      {/* A PAID YEAR, IN THREE STATES. The control is ABSENT rather than disabled outside the
          window — a disabled button invites a support call asking why — and the absence is
          EXPLAINED, with the date to come back on when we have one.

          HELD first: a garage that has already chosen must be told what it chose, not shown the
          choice again. Nothing of ours records the hold; `heldForRenewal` is Stripe's own schedule,
          read live in getServerSideProps, so this cannot describe a pending state that has since
          been released somewhere else. */}
      {billingConfigured && annualLocked && heldForRenewal && (
        <div className="max-w-xl mt-4 bg-surface border border-line rounded-xl p-4" data-testid="plan-hold-pending">
          <p className="text-sm text-ink">
            You’ve asked to move to the <span className="font-medium">monthly</span> plan
            {renewalLabel ? <> from <span className="font-medium">{renewalLabel}</span></> : ' at your renewal'}.
            Your yearly plan runs until then and nothing changes before it.
          </p>
          <button
            onClick={() => go('/api/stripe/change-plan', { plan: 'annual' })}
            disabled={busy}
            data-testid="plan-hold-cancel"
            className="mt-3 bg-surface hover:bg-surface-muted text-ink border border-line rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Changing…' : 'Stay on yearly'}
          </button>
        </div>
      )}

      {/* THE WINDOW IS OPEN. Its own block rather than the PlanChooser: the chooser's copy is about
          a trial that is ending and a first charge, and neither is true here. What is true is two
          figures and a date, so that is what it says. */}
      {billingConfigured && annualLocked && !heldForRenewal && windowOpen && (
        <div className="max-w-xl mt-4 bg-surface border border-line rounded-xl p-4" data-testid="plan-window-open">
          <p className="text-sm text-ink font-medium mb-1">
            You’re on the <span className="font-medium">yearly</span> plan.
          </p>
          <p className="text-sm text-muted">
            Your renewal{renewalLabel ? <> on <span className="text-ink font-medium">{renewalLabel}</span></> : ''} is
            close enough to change what happens next. You can move to monthly from that date instead
            of renewing for another year. The year you’ve paid for is not shortened and nothing is
            refunded.
          </p>
          {/* ITS OWN TESTID, not plan-switch-to-monthly. That one belongs to the trial switch, and
              a clause asserting "the trial control is absent" would have found this button instead
              and passed against the wrong subject. */}
          <button
            onClick={() => go('/api/stripe/change-plan', { plan: 'monthly' })}
            disabled={busy}
            data-testid="plan-window-to-monthly"
            className="mt-3 bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Changing…' : 'Move to monthly at renewal'}
          </button>
        </div>
      )}

      {/* OUTSIDE THE WINDOW. The dated sentence is the point: "your plan can be changed at renewal"
          was true and unactionable, and a garage reading it had no idea when to come back. */}
      {billingConfigured && annualLocked && !heldForRenewal && !windowOpen && (
        <div className="max-w-xl mt-4 bg-surface border border-line rounded-xl p-4" data-testid="plan-switch-locked">
          <p className="text-sm text-ink">
            You’re on the <span className="font-medium">yearly</span> plan, paid for the year.
            {/* THE SENTENCES ARE SINGLE EXPRESSIONS where a number sits inside the words. React
                puts an SSR comment marker around every interpolation, so `the last {windowDays}
                days` renders as `the last <!-- -->14<!-- --> days` — a clause reading the page for
                that phrase goes red over the renderer rather than over the copy. */}
            {windowOpensLabel && renewalLabel
              ? <> You can change to monthly from <span className="font-medium">{windowOpensLabel}</span>{`, the last ${windowDays} days before your renewal on `}<span className="font-medium">{renewalLabel}</span>.</>
              : ` You can change to monthly in the last ${windowDays} days before your renewal.`}
          </p>
        </div>
      )}

      {/* SWITCHING DURING THE TRIAL. Present only while trialing; see the derivation above. The
          SAME chooser as the signup screen, so the figures a garage switches on are the figures it
          was quoted — one resolver, one renderer, no second copy of the arithmetic. */}
      {billingConfigured && canSwitch && choice && (
        <div className="max-w-xl mt-4 bg-surface border border-line rounded-xl p-4" data-testid="plan-switch">
          <p className="text-sm text-ink font-medium mb-3">
            You’re on the <span data-testid="plan-switch-current">{currentPlan === 'annual' ? 'yearly' : 'monthly'}</span> plan.
          </p>
          <PlanChooser choice={choice} value={plan} onChange={setPlan} disabled={busy} />
          <p className="text-xs text-muted mt-2">
            You can change this while your trial is running. Nothing is charged and your trial end date does not move.
          </p>
          {switchTo ? (
            <button
              onClick={() => go('/api/stripe/change-plan', { plan: switchTo })}
              disabled={busy}
              data-testid={`plan-switch-to-${switchTo}`}
              className="mt-3 bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50"
            >
              {busy ? 'Changing…' : switchTo === 'annual' ? 'Switch to yearly' : 'Switch to monthly'}
            </button>
          ) : (
            <p className="text-sm text-muted mt-3" data-testid="plan-switch-already">
              This is the plan you’re on.
            </p>
          )}
        </div>
      )}

      <div className="max-w-xl mt-4 flex flex-wrap gap-3">
        {!billingConfigured ? (
          <p className="text-sm text-muted">Card billing isn’t switched on for this environment yet.</p>
        ) : hasCustomer ? (
          <button onClick={() => go('/api/stripe/portal')} disabled={busy} className="bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">
            {busy ? 'Opening…' : 'Manage billing'}
          </button>
        ) : (
          <button onClick={() => go('/api/stripe/checkout', { plan })} disabled={busy} data-testid="licence-start-subscription" className="bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">
            {busy ? 'Opening…' : 'Start subscription'}
          </button>
        )}
      </div>
      {hasCustomer && billingConfigured && (
        <p className="text-xs text-muted mt-2 max-w-xl">Card details, plan changes and cancellation are handled securely by Stripe.</p>
      )}
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;
  // NARROWED, not asserted. vis.groupId is `string | null` because operators and reps have no
  // tenant; a null reaching a where clause is not a filter, it is a question nobody answered.
  if (!vis.groupId) return { redirect: { destination: '/admin/login', permanent: false } };
  const groupId = vis.groupId;

  const [group, billing, siteCount, latestTerms] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, country_code: true, ref: true, is_demo: true, trial_ends_at: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { subscription_status: true, current_period_end: true, stripe_customer_id: true, stripe_subscription_id: true, first_paid_at: true } }),
    prisma.site.count({ where: { group_id: groupId } }),
    // WHAT THEY ARE ON NOW. The plan is not in the billing cache, so it is read from the terms
    // timeline, which the webhook appends to on every change — the latest row is the current shape.
    prisma.tenantPlanTerms.findFirst({ where: { group_id: groupId }, orderBy: { effective_from: 'desc' }, select: { plan: true } }),
  ]);

  // A DEMO MAY NOT BUY ANYTHING, so it is not offered a price to look at (see the panel above).
  // The trial end comes from Group.trial_ends_at, which lib/stripe-billing-cache mirrors back from
  // Stripe's own trial_end. NOT from current_period_end, which is a different question: the end of
  // the trial and the next renewal coincide on a new subscription and part company at the first
  // renewal. (That column was ALSO null on every row until 2026-10-29 — the cache was reading a
  // field Basil removed — which is why this comment used to give that as the reason.)
  const choice = (group as any)?.is_demo
    ? null
    : await planChoiceFor(prisma, groupId, {
        country: group?.country_code ?? null,
        sites: siteCount,
        trialEndsAt: (group as any)?.trial_ends_at ?? null,
      });
  const planRow = latestTerms?.plan ?? null;
  const currentPlan = planRow === null ? null : planRow === 'monthly' ? 'monthly' as const : 'annual' as const;
  const annualLocked = annualPaidIn({ plan: planRow as PlanKind | null, firstPaidAt: billing?.first_paid_at ?? null });

  // ── THE RENEWAL DATE AND ANY HELD MOVE, FROM STRIPE ITSELF ──────────────────────────────────
  // ONLY for a garage the window can apply to, so an ordinary page load costs no Stripe call.
  //
  // LIVE, not mirrored. A pending move held in a column of ours is a thing that can go stale and
  // lie, and a licences screen describing a plan the garage was not on is the fault this whole
  // design came out of. The cached current_period_end is the FALLBACK, not the source: a Stripe
  // outage should cost the pending state, not the whole page.
  //
  // THREE STATES. A failed read leaves renewalAt null, and null is UNKNOWN — the window is shut
  // and the copy names no date rather than one derived from a date we do not have.
  let liveRenewalAt: Date | null = null;
  let heldForRenewal = false;
  if (annualLocked) {
    const { getStripe } = await import('@/lib/stripe');
    const { renewalAtOf } = await import('@/lib/stripe-period');
    const stripe = getStripe();
    const subId = billing?.stripe_subscription_id ?? null;
    if (stripe && subId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        liveRenewalAt = renewalAtOf(sub);
        heldForRenewal = !!pendingScheduleId(sub);
      } catch (e: any) {
        // SAID OUT LOUD. The page still renders, with the undated copy, and this is the only
        // record that it did so because Stripe could not be reached.
        console.error('[licences] could not read the subscription for the renewal window —', e?.message);
      }
    }
  }
  // ONE RESOLUTION, shared with change-plan (lib/renewal-window): live first, the cache only as a
  // fallback, and a CACHED date already in the past is stale rather than a renewal.
  const renewalAt = renewalAtFor({ live: liveRenewalAt, cached: billing?.current_period_end, now: new Date() });
  const win = monthlySwitchWindow({ renewalAt, now: new Date() });
  const profile = resolveTenantProfile(group);

  return {
    props: {
      groupName: group?.group_name ?? 'Your account',
      subscriptionStatus: billing?.subscription_status ?? null,
      currentPeriodEnd: billing?.current_period_end ? billing.current_period_end.toISOString() : null,
      periodEndLabel: billing?.current_period_end ? formatProfileDate(resolveTenantProfile(group), billing.current_period_end, { long: true }) : null,
      hasCustomer: !!billing?.stripe_customer_id,
      siteCount,
      perMonthLabel: monthlyPriceLabelFor(resolveTenantProfile(group), siteCount),
      perLocationLbl: perLocationLabelFor(resolveTenantProfile(group)),
      billingConfigured: !!process.env.STRIPE_SECRET_KEY,
      isDemo: !!(group as any)?.is_demo,
      isAdmin: true,
      choice,
      currentPlan,
      annualLocked,
      windowOpen: win.open,
      renewalLabel: renewalAt ? formatProfileDate(profile, renewalAt, { long: true }) : null,
      windowOpensLabel: win.opensAt ? formatProfileDate(profile, win.opensAt, { long: true }) : null,
      heldForRenewal,
      windowDays: WINDOW_DAYS,
    },
  };
};
