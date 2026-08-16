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
  const { groupName, subscriptionStatus, currentPeriodEnd, periodEndLabel, hasCustomer, siteCount, perMonthLabel, perLocationLbl, billingConfigured, isAdmin, isDemo } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lapsed = isLapsedStatus(subscriptionStatus); // the ONE vocabulary (lib/billing)
  const subscribed = subscriptionStatus === 'trialing' || subscriptionStatus === 'active' || subscriptionStatus === 'past_due';

  async function go(path: string) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(path, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.message || 'Could not open billing.');
      window.location.href = data.url;
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

      <div className="max-w-xl mt-4 flex flex-wrap gap-3">
        {!billingConfigured ? (
          <p className="text-sm text-muted">Card billing isn’t switched on for this environment yet.</p>
        ) : hasCustomer ? (
          <button onClick={() => go('/api/stripe/portal')} disabled={busy} className="bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">
            {busy ? 'Opening…' : 'Manage billing'}
          </button>
        ) : (
          <button onClick={() => go('/api/stripe/checkout')} disabled={busy} className="bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50">
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

  const [group, billing, siteCount] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, country_code: true, ref: true, is_demo: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: groupId }, select: { subscription_status: true, current_period_end: true, stripe_customer_id: true } }),
    prisma.site.count({ where: { group_id: groupId } }),
  ]);

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
    },
  };
};
