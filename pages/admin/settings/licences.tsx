/**
 * File: pages/admin/settings/licences.tsx
 * Settings → Licence & Subscriptions. Shows the subscription (Stripe cache) + billable location
 * count, and hosts the two hosted-Stripe actions: Start subscription (Checkout) and Manage billing
 * (Billing Portal — card, plan changes, cancellation all live there; we build no bespoke cancel).
 * A LAPSED tenant sees the read-only guarantee loudly.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { monthlyPriceLabel, perLocationLabel } from '@/lib/billing-pricing';

type PageProps = {
  groupName: string;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  hasCustomer: boolean;
  siteCount: number;
  perMonthPounds: number;
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

const LAPSED = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
const STATUS_LABEL: Record<string, string> = {
  trialing: 'Trial', active: 'Active', past_due: 'Payment retrying', canceled: 'Lapsed',
  unpaid: 'Lapsed', paused: 'Paused', incomplete: 'Awaiting payment', incomplete_expired: 'Lapsed',
};

export default function LicencesSettings(props: PageProps) {
  const { groupName, subscriptionStatus, currentPeriodEnd, hasCustomer, siteCount, perMonthPounds, billingConfigured, isAdmin } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lapsed = !!subscriptionStatus && LAPSED.has(subscriptionStatus);
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

  return (
    <SettingsLayout isAdmin={isAdmin}>
      <Head><title>Licence & Subscriptions - GreaseDesk</title></Head>
      <p className="text-muted mb-6">Your GreaseDesk subscription. Billing is {perLocationLabel()} per location, per month.</p>

      {lapsed && (
        <div className="bg-warn-soft border border-warn text-warn rounded-xl p-4 max-w-xl mb-4">
          Your subscription has lapsed. <span className="font-medium">Your records are safe and fully exportable</span> — every invoice stays viewable and downloadable, forever. Resubscribe to add new work.
        </div>
      )}

      <div className="bg-surface border border-line rounded-xl p-6 max-w-xl">
        <Row label="Account" value={groupName} />
        <Row label="Status" value={subscriptionStatus ? (STATUS_LABEL[subscriptionStatus] || subscriptionStatus) : 'No subscription'} />
        <Row label="Current locations" value={siteCount} />
        <Row label="Monthly" value={monthlyPriceLabel(siteCount)} />
        {currentPeriodEnd && <Row label={subscribed ? 'Renews / next charge' : 'Period end'} value={new Date(currentPeriodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} />}
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

  const [group, billing, siteCount] = await Promise.all([
    prisma.group.findUnique({ where: { id: vis.groupId }, select: { group_name: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: vis.groupId }, select: { subscription_status: true, current_period_end: true, stripe_customer_id: true } }),
    prisma.site.count({ where: { group_id: vis.groupId } }),
  ]);

  return {
    props: {
      groupName: group?.group_name ?? 'Your account',
      subscriptionStatus: billing?.subscription_status ?? null,
      currentPeriodEnd: billing?.current_period_end ? billing.current_period_end.toISOString() : null,
      hasCustomer: !!billing?.stripe_customer_id,
      siteCount,
      perMonthPounds: 35 * Math.max(1, siteCount),
      billingConfigured: !!process.env.STRIPE_SECRET_KEY,
      isAdmin: true,
    },
  };
};
