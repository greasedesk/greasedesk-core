/**
 * File: pages/admin/settings/company/account.tsx
 * Company Profile → Account Details (ADMIN/owner only). Read-only tenant account: reference,
 * status, trial end. Relocated here from the dissolved Profile tab. i18n-native; light theme.
 */
import React from 'react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';

type PageProps = { reference: string; status: string; trialEndsAt: string | null };

export default function AccountDetails({ reference, status, trialEndsAt }: PageProps) {
  const { t } = useTranslation('company');
  const ends = trialEndsAt ? new Date(trialEndsAt).toLocaleDateString('en-GB') : '—';
  return (
    <SettingsLayout isAdmin>
      <Head><title>Account details - GreaseDesk</title></Head>
      <div className="bg-surface border border-line rounded-xl p-6 max-w-md">
        <h2 className="text-lg font-semibold text-ink mb-1">{t('account.title')}</h2>
        <p className="text-sm text-muted mb-4">{t('account.intro')}</p>
        <div className="space-y-2 text-sm">
          <div><span className="text-muted">{t('account.reference')}: </span><span className="text-ink font-mono">{reference}</span> <span className="text-muted text-xs">({t('account.permanent')})</span></div>
          <div><span className="text-muted">{t('account.status')}: </span><span className="text-ink capitalize">{status}</span></div>
          <div><span className="text-muted">{t('account.trialEnds')}: </span><span className="text-ink">{ends}</span></div>
        </div>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['company'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const g = (await prisma.group.findUnique({
    where: { id: gate.vis.groupId as string },
    select: { ref: true, status: true, trial_ends_at: true },
  })) as { ref: string; status: string; trial_ends_at: Date | null } | null;
  return {
    props: {
      reference: g?.ref ?? '—',
      status: g?.status ?? '—',
      trialEndsAt: g?.trial_ends_at ? g.trial_ends_at.toISOString() : null,
    },
  };
});
