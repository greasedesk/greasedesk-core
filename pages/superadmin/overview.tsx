/**
 * File: pages/superadmin/overview.tsx
 * The Engine Room READ-ONLY tenant list — the Support role's landing. Any operator may view it
 * (owner/CM land on the fuller /superadmin/tenants dashboard instead); it is REGION-SCOPED from the
 * principal and carries NO lifecycle actions — Support has read-only tenant visibility. Standalone,
 * like the dashboard, so _app never wraps it in AdminLayout.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorPage, operatorTenantScope } from '@/lib/operator-auth';
import { TMBS_GROUP_ID } from '@/lib/superadmin';

type Row = { id: string; name: string; ref: string; status: string; subscriptionStatus: string | null; sites: number; users: number; archived: boolean; isTmbs: boolean };
type PageProps = { tenants: Row[]; role: string };

export default function EngineRoomOverview({ tenants, role }: PageProps) {
  return (
    <>
      <Head><title>Engine Room — tenants</title><meta name="robots" content="noindex" /></Head>
      <main className="min-h-screen bg-slate-50 p-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-baseline justify-between mb-4">
            <h1 className="text-xl font-semibold text-slate-900">Tenants</h1>
            <span className="text-xs text-slate-500">read-only · {role}</span>
          </div>
          <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-600">
                <tr><th className="text-left px-3 py-2">Ref</th><th className="text-left px-3 py-2">Name</th><th className="text-left px-3 py-2">Status</th><th className="text-left px-3 py-2">Billing</th><th className="text-right px-3 py-2">Sites</th><th className="text-right px-3 py-2">Users</th></tr>
              </thead>
              <tbody>
                {tenants.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No tenants in scope.</td></tr>}
                {tenants.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-slate-700">{t.ref}{t.isTmbs && <span className="ml-1 text-[10px] text-amber-600">TMBS</span>}</td>
                    <td className="px-3 py-2 text-slate-900">{t.name}</td>
                    <td className="px-3 py-2">{t.archived ? <span className="text-slate-400">archived</span> : t.status}</td>
                    <td className="px-3 py-2 text-slate-600">{t.subscriptionStatus ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.sites}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOperatorPage(ctx); // ANY operator (Support included); wrong class → 404
  if (!gate.ok) return { notFound: true };
  const groups = await prisma.group.findMany({
    where: operatorTenantScope(gate.op), // REGION-SCOPED from the principal
    orderBy: { created_at: 'desc' },
    select: { id: true, group_name: true, ref: true, status: true, archived_at: true, billing: { select: { subscription_status: true } }, _count: { select: { sites: true, users: true } } },
  });
  return {
    props: {
      role: gate.op.role,
      tenants: groups.map((g: any) => ({
        id: g.id, name: g.group_name, ref: g.ref, status: g.status,
        subscriptionStatus: g.billing?.subscription_status ?? null,
        sites: g._count.sites, users: g._count.users, archived: !!g.archived_at, isTmbs: g.id === TMBS_GROUP_ID,
      })),
    },
  };
};
