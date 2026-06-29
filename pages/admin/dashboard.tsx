/**
 * File: pages/admin/dashboard.tsx
 * Authenticated landing page. Now SSR-loads the tenant's trial status for a DISPLAY-ONLY
 * countdown banner (no enforcement at expiry — toothless by design).
 * (The three metric tiles below remain placeholders — out of scope for this slice.)
 */
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';
import { daysLeft } from '@/lib/trial';

type PageProps = {
  groupName: string;
  ref: string;
  status: string;
  trialEndsAt: string | null;
};

function TrialBanner({ status, trialEndsAt }: { status: string; trialEndsAt: string | null }) {
  // Display only. A passed date just shows "trial ended" — nothing is gated.
  let text: string;
  let tone = 'bg-slate-800 border-slate-700 text-slate-200';
  if (status !== 'trial') {
    text = `Account status: ${status}`;
    if (status === 'active') tone = 'bg-green-900/40 border-green-700 text-green-100';
    else if (status === 'suspended' || status === 'cancelled') tone = 'bg-red-900/40 border-red-700 text-red-100';
  } else {
    const d = daysLeft(trialEndsAt);
    if (d == null) text = 'Trial active';
    else if (d > 0) { text = `${d} day${d === 1 ? '' : 's'} left in your trial`; tone = 'bg-blue-900/40 border-blue-700 text-blue-100'; }
    else { text = 'Trial ended'; tone = 'bg-amber-900/40 border-amber-700 text-amber-100'; }
  }
  return <div className={`rounded-xl border p-4 mb-6 ${tone}`}>{text}</div>;
}

export default function AdminDashboard({ groupName, ref, status, trialEndsAt }: PageProps) {
  return (
    <AdminLayout>
      <Head>
        <title>Dashboard - GreaseDesk</title>
      </Head>

      <h1 className="text-4xl font-bold text-blue-400 mb-1">Welcome Back!</h1>
      <p className="text-slate-400 mb-6">{groupName} · <span className="font-mono">{ref}</span></p>

      <TrialBanner status={status} trialEndsAt={trialEndsAt} />

      {/* --- Dashboard Content (placeholder metrics — not wired yet) --- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <h2 className="text-xl font-semibold text-white mb-3">Live Job Cards</h2>
          <p className="text-3xl text-yellow-400">4</p>
        </div>
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <h2 className="text-xl font-semibold text-white mb-3">Today's Bookings</h2>
          <p className="text-3xl text-green-400">2</p>
        </div>
        <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
          <h2 className="text-xl font-semibold text-white mb-3">Revenue (Today)</h2>
          <p className="text-3xl text-blue-400">£450.00</p>
        </div>
      </div>
    </AdminLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }
  const group = (await prisma.group.findUnique({
    where: { id: user.group_id },
    select: { group_name: true, ref: true, status: true, trial_ends_at: true },
  })) as { group_name: string; ref: string; status: string; trial_ends_at: Date | null } | null;

  return {
    props: {
      groupName: group?.group_name ?? 'Your garage',
      ref: group?.ref ?? '—',
      status: group?.status ?? 'trial',
      trialEndsAt: group?.trial_ends_at ? group.trial_ends_at.toISOString() : null,
    },
  };
};
