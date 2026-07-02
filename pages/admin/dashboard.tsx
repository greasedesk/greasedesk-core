/**
 * File: pages/admin/dashboard.tsx
 * Authenticated landing page. Now SSR-loads the tenant's trial status for a DISPLAY-ONLY
 * countdown banner (no enforcement at expiry — toothless by design).
 * (The three metric tiles below remain placeholders — out of scope for this slice.)
 */
import Head from 'next/head';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { daysLeft } from '@/lib/trial';
import { formatMoney } from '@/lib/format-money';
import { withI18n } from '@/lib/gssp-i18n';

type PageProps = {
  groupName: string;
  accountRef: string;
  status: string;
  trialEndsAt: string | null;
  currency: string;
  locale: string;
};

function TrialBanner({ status, trialEndsAt }: { status: string; trialEndsAt: string | null }) {
  // Display only. A passed date just shows "trial ended" — nothing is gated.
  let text: string;
  let tone = 'bg-surface border-line text-ink';
  if (status !== 'trial') {
    text = `Account status: ${status}`;
    if (status === 'active') tone = 'bg-ok-soft border-line text-ok';
    else if (status === 'suspended' || status === 'cancelled') tone = 'bg-danger-soft border-line text-danger';
  } else {
    const d = daysLeft(trialEndsAt);
    if (d == null) text = 'Trial active';
    else if (d > 0) { text = `${d} day${d === 1 ? '' : 's'} left in your trial`; tone = 'bg-accent-soft border-accent text-accent'; }
    else { text = 'Trial ended'; tone = 'bg-warn-soft border-warn text-warn'; }
  }
  return <div className={`rounded-xl border p-4 mb-6 ${tone}`}>{text}</div>;
}

export default function AdminDashboard({ groupName, accountRef, status, trialEndsAt, currency, locale }: PageProps) {
  const { t } = useTranslation('common');
  return (
    <>
      <Head>
        <title>Dashboard - GreaseDesk</title>
      </Head>

      <h1 className="text-4xl font-bold text-accent mb-1">{t('dashboard.welcome')}</h1>
      <p className="text-muted mb-6">{groupName} · <span className="font-mono">{accountRef}</span></p>

      <TrialBanner status={status} trialEndsAt={trialEndsAt} />

      {/* --- Dashboard Content (placeholder metrics — not wired yet) --- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-surface p-6 rounded-xl border border-line shadow-lg">
          <h2 className="text-xl font-semibold text-ink mb-3">{t('dashboard.liveJobCards')}</h2>
          <p className="text-3xl text-warn">4</p>
        </div>
        <div className="bg-surface p-6 rounded-xl border border-line shadow-lg">
          <h2 className="text-xl font-semibold text-ink mb-3">{t('dashboard.todaysBookings')}</h2>
          <p className="text-3xl text-ok">2</p>
        </div>
        <div className="bg-surface p-6 rounded-xl border border-line shadow-lg">
          <h2 className="text-xl font-semibold text-ink mb-3">{t('dashboard.revenueToday')}</h2>
          {/* Demo figure (45000 pennies) — proves the single money chokepoint, site currency/locale. */}
          <p className="text-3xl text-accent">{formatMoney(45000, { currency, locale })}</p>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n()(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }
  const group = (await prisma.group.findUnique({
    where: { id: user.group_id },
    select: { group_name: true, ref: true, status: true, trial_ends_at: true },
  })) as { group_name: string; ref: string; status: string; trial_ends_at: Date | null } | null;

  // Money formats against the SITE's currency/locale (already on the Site model).
  const site = user.site_id
    ? ((await prisma.site.findUnique({ where: { id: user.site_id }, select: { currency_code: true, locale: true } })) as { currency_code: string; locale: string } | null)
    : null;

  return {
    props: {
      groupName: group?.group_name ?? 'Your garage',
      accountRef: group?.ref ?? '—',
      status: group?.status ?? 'trial',
      trialEndsAt: group?.trial_ends_at ? group.trial_ends_at.toISOString() : null,
      currency: site?.currency_code ?? 'GBP',
      locale: site?.locale ?? 'en-GB',
    },
  };
});
