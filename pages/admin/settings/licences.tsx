/**
 * File: pages/admin/settings/licences.tsx
 * Settings → Licences & Subscriptions. Read-only view of the Group's billing/plan and
 * site (billable unit) count. Billing management is a later module.
 */
import React from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';

type PageProps = {
  groupName: string;
  plan: string | null;
  status: string | null;
  includedSites: number | null;
  siteCount: number;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 border-b border-slate-700">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-100 font-medium">{value ?? '—'}</span>
    </div>
  );
}

export default function LicencesSettings({ groupName, plan, status, includedSites, siteCount }: PageProps) {
  return (
    <SettingsLayout>
      <Head><title>Licences & Subscriptions - GreaseDesk</title></Head>
      <p className="text-slate-400 mb-6">Your plan and billable units. Billing is driven by the number of locations. Management is a later module.</p>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-xl">
        <Row label="Account" value={groupName} />
        <Row label="Plan" value={plan} />
        <Row label="Status" value={status} />
        <Row label="Included locations" value={includedSites} />
        <Row label="Current locations" value={siteCount} />
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  const [group, billing, siteCount] = await Promise.all([
    prisma.group.findUnique({ where: { id: user.group_id }, select: { group_name: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: user.group_id }, select: { plan_name: true, status: true, included_sites: true } }),
    prisma.site.count({ where: { group_id: user.group_id } }),
  ]);

  return {
    props: {
      groupName: group?.group_name ?? 'Your account',
      plan: billing?.plan_name ?? null,
      status: billing?.status ?? null,
      includedSites: billing?.included_sites ?? null,
      siteCount,
    },
  };
};
