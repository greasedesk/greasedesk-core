/**
 * File: pages/admin/jobcards/index.tsx
 * Slice 1: job-card list for the current tenant.
 *
 * SSR read pattern mirrors pages/admin/settings.tsx: getServerSession → guard →
 * Prisma query scoped to the session's group_id. Never returns another tenant's cards.
 */
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';
import { getVisibility } from '@/lib/site-visibility';

type Stages = {
  details: boolean;
  intake: boolean;
  injob: boolean;
  complete: boolean;
};

type JobCardRow = {
  id: string;
  registration: string;
  customerName: string;
  status: string;
  createdAt: string; // ISO
  stages: Stages;
};

type PageProps = { cards: JobCardRow[]; noSites: boolean };

const STAGE_LABELS: Array<[keyof Stages, string]> = [
  ['details', 'Job Card'],
  ['intake', 'Intake'],
  ['injob', 'In-Job'],
  ['complete', 'Complete'],
];

function StageBadges({ stages }: { stages: Stages }) {
  return (
    <div className="flex flex-wrap gap-1">
      {STAGE_LABELS.map(([key, label]) => (
        <span
          key={key}
          className={`text-xs px-2 py-0.5 rounded-full border ${
            stages[key]
              ? 'bg-green-800 text-green-100 border-green-600'
              : 'bg-slate-700 text-slate-300 border-slate-600'
          }`}
          title={stages[key] ? `${label}: Done` : `${label}: Pending`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export default function JobCardsListPage({ cards, noSites }: PageProps) {
  return (
    <AdminLayout>
      <Head>
        <title>Job Cards - GreaseDesk</title>
      </Head>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-white">Job Cards</h1>
        <Link
          href="/admin/jobcards/new"
          className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold rounded-lg px-4 py-2 text-sm"
        >
          + New Job Card
        </Link>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm text-slate-200">
          <thead className="bg-slate-900/60 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-4 py-3">Reg</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Stages</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {cards.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  {noSites
                    ? "You're not currently assigned to a location — contact your admin."
                    : 'No job cards yet. Create the first one.'}
                </td>
              </tr>
            )}
            {cards.map((c) => (
              <tr key={c.id} className="border-t border-slate-700 hover:bg-slate-700/30">
                <td className="px-4 py-3 font-semibold">
                  <Link href={`/admin/jobcards/${c.id}`} className="text-blue-400 hover:underline">
                    {c.registration}
                  </Link>
                </td>
                <td className="px-4 py-3">{c.customerName}</td>
                <td className="px-4 py-3">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 border border-slate-600 capitalize">
                    {c.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StageBadges stages={c.stages} />
                </td>
                <td className="px-4 py-3 text-slate-400">
                  {new Date(c.createdAt).toLocaleDateString('en-GB')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  type JobCardListDbRow = {
    id: string;
    status: string;
    created_at: Date;
    stage_details_done: boolean;
    stage_intake_done: boolean;
    stage_injob_done: boolean;
    stage_complete_done: boolean;
    customer: { name: string } | null;
    vehicle: { registration: string } | null;
  };

  const vis = await getVisibility(user.id as string); // role/assignment site visibility

  const rows = (await prisma.jobCard.findMany({
    where: { site_id: { in: vis.siteIds } }, // visible sites only
    orderBy: { created_at: 'desc' },
    include: {
      customer: { select: { name: true } },
      vehicle: { select: { registration: true } },
    },
  })) as JobCardListDbRow[];

  const cards: JobCardRow[] = rows.map((r: JobCardListDbRow) => ({
    id: r.id,
    registration: r.vehicle?.registration ?? '—',
    customerName: r.customer?.name ?? '—',
    status: r.status,
    createdAt: r.created_at.toISOString(),
    stages: {
      details: r.stage_details_done,
      intake: r.stage_intake_done,
      injob: r.stage_injob_done,
      complete: r.stage_complete_done,
    },
  }));

  return { props: { cards, noSites: vis.siteIds.length === 0 } };
};
