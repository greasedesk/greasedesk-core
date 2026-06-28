/**
 * File: pages/admin/jobcards/[id].tsx
 * Slice 1: view a single job card.
 *
 * SSR read scoped to the session's group_id (ownership enforced via findFirst on
 * id + group_id). A card belonging to another tenant returns 404, never leaks.
 */
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';

type Stage = { label: string; done: boolean };
type Flag = { label: string; on: boolean };

type CardProps = {
  id: string;
  status: string;
  createdAt: string;
  registration: string;
  vin: string | null;
  mileage: number | null;
  customerName: string;
  phone: string | null;
  email: string | null;
  stages: Stage[];
  flags: Flag[];
};

type PageProps = { card: CardProps };

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase text-slate-400 mb-1">{label}</div>
      <div className="text-slate-100">{value || '—'}</div>
    </div>
  );
}

export default function JobCardDetailPage({ card }: PageProps) {
  return (
    <AdminLayout>
      <Head>
        <title>Job Card {card.registration} - GreaseDesk</title>
      </Head>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-white">{card.registration}</h1>
          <p className="text-slate-400 text-sm mt-1">
            Created {new Date(card.createdAt).toLocaleString('en-GB')} · Status:{' '}
            <span className="capitalize">{card.status}</span>
          </p>
        </div>
        <Link href="/admin/jobcards" className="text-sm text-slate-400 hover:text-white">
          ← Back to list
        </Link>
      </div>

      {/* Four-stage status */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 mb-5">
        <h2 className="text-lg font-semibold text-white mb-3">Status (four stages)</h2>
        <div className="flex flex-wrap gap-2">
          {card.stages.map((s) => (
            <span
              key={s.label}
              className={`text-sm px-3 py-1 rounded-full border ${
                s.done
                  ? 'bg-green-800 text-green-100 border-green-600'
                  : 'bg-slate-700 text-slate-300 border-slate-600'
              }`}
            >
              {s.label}: {s.done ? 'Done' : 'Pending'}
            </span>
          ))}
        </div>
      </div>

      {/* Vehicle + customer */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 mb-5">
        <h2 className="text-lg font-semibold text-white mb-4">Vehicle &amp; Customer</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Registration" value={card.registration} />
          <Field label="VIN" value={card.vin} />
          <Field label="Mileage" value={card.mileage != null ? card.mileage.toLocaleString('en-GB') : null} />
          <Field label="Customer" value={card.customerName} />
          <Field label="Phone" value={card.phone} />
          <Field label="Email" value={card.email} />
        </div>
      </div>

      {/* Flags */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
        <h2 className="text-lg font-semibold text-white mb-3">Flags</h2>
        {card.flags.some((f) => f.on) ? (
          <div className="flex flex-wrap gap-2">
            {card.flags
              .filter((f) => f.on)
              .map((f) => (
                <span key={f.label} className="text-sm px-3 py-1 rounded-lg bg-blue-600 text-white border border-blue-400">
                  {f.label}
                </span>
              ))}
          </div>
        ) : (
          <p className="text-slate-400 text-sm">No flags set.</p>
        )}
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

  const id = ctx.params?.id as string;

  // Ownership: only resolve cards within the caller's group.
  const row = await prisma.jobCard.findFirst({
    where: { id, group_id: user.group_id },
    include: {
      customer: { select: { name: true, phone: true, email: true } },
      vehicle: { select: { registration: true, vin: true, mileage_at_create: true } },
    },
  });

  if (!row) return { notFound: true };

  const card: CardProps = {
    id: row.id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    registration: row.vehicle?.registration ?? '—',
    vin: row.vehicle?.vin ?? null,
    mileage: row.odometer_in ?? row.vehicle?.mileage_at_create ?? null,
    customerName: row.customer?.name ?? '—',
    phone: row.customer?.phone ?? null,
    email: row.customer?.email ?? null,
    stages: [
      { label: 'Job Card', done: row.stage_details_done },
      { label: 'Intake Photos', done: row.stage_intake_done },
      { label: 'In-Job', done: row.stage_injob_done },
      { label: 'Complete Photos', done: row.stage_complete_done },
    ],
    flags: [
      { label: 'Urgent / Priority', on: row.flag_urgent },
      { label: 'Sales Car', on: row.flag_sales_car },
      { label: 'Customer Car', on: row.flag_customer_car },
      { label: 'MOT', on: row.flag_mot },
      { label: 'DIAG', on: row.flag_diag },
    ],
  };

  return { props: { card } };
};
