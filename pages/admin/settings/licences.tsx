/**
 * File: pages/admin/settings/licences.tsx
 * Settings → Licences & Subscriptions. Read-only view of the Group's billing/plan and
 * site (billable unit) count. Billing management is a later module.
 */
import React from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';

type PageProps = {
  groupName: string;
  plan: string | null;
  status: string | null;
  includedSites: number | null;
  siteCount: number;
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

export default function LicencesSettings({ groupName, plan, status, includedSites, siteCount, isAdmin }: PageProps) {
  return (
    <SettingsLayout isAdmin={isAdmin}>
      <Head><title>Licences & Subscriptions - GreaseDesk</title></Head>
      <p className="text-muted mb-6">Your plan and billable units. Billing is driven by the number of locations. Management is a later module.</p>

      <div className="bg-surface border border-line rounded-xl p-6 max-w-xl">
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
  // ADMIN-ONLY: billing/plan information is not exposed to STANDARD users.
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;

  const [group, billing, siteCount] = await Promise.all([
    prisma.group.findUnique({ where: { id: vis.groupId }, select: { group_name: true } }),
    prisma.groupBilling.findUnique({ where: { group_id: vis.groupId }, select: { plan_name: true, status: true, included_sites: true } }),
    prisma.site.count({ where: { group_id: vis.groupId } }),
  ]);

  return {
    props: {
      groupName: group?.group_name ?? 'Your account',
      plan: billing?.plan_name ?? null,
      status: billing?.status ?? null,
      includedSites: billing?.included_sites ?? null,
      siteCount,
      isAdmin: true,
    },
  };
};
