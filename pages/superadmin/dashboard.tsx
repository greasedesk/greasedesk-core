/**
 * File: pages/superadmin/dashboard.tsx
 * Engine Room home — all roles. The platform design puts TOTAL REVENUE and the RETAINED-REVENUE
 * FORECAST here (region-scoped, reading the commission engine). Those figures are NOT wired yet:
 * billing is dormant (no live payments) and the commission engine has no rates/attributions, so a
 * forecast would be a fabricated zero. So this shows an HONEST placeholder for the money tiles —
 * stating what's coming — alongside a REAL, region-scoped figure (tenants in scope) so the screen is
 * a true landing, not a broken tile.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorPage, operatorTenantScope, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type PageProps = { role: OperatorRoleName; scopeLabel: string; tenantCount: number };

function ComingTile({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="text-sm text-slate-400">{title}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-500">—</div>
      <div className="mt-1 text-xs text-slate-500">{note}</div>
    </div>
  );
}

export default function EngineRoomDashboard({ role, scopeLabel, tenantCount }: PageProps) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — dashboard</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-5xl">
        <div className="flex items-baseline justify-between mb-5">
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <span className="text-xs text-slate-400">scope: {scopeLabel} · {role.replace('_', ' ')}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ComingTile title="Total revenue (this month)" note="Arrives when billing goes live." />
          <ComingTile title="Retained revenue (forecast)" note="After commission — reads the commission engine once rates & payments are live." />
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <div className="text-sm text-slate-400">Tenants in scope</div>
            <div className="mt-2 text-2xl font-semibold text-white tabular-nums">{tenantCount}</div>
            <div className="mt-1 text-xs text-slate-500">Region-scoped to your access.</div>
          </div>
        </div>
        <p className="mt-6 text-sm text-slate-500">
          Revenue and retained-revenue forecast will populate here from the commission engine once Stripe billing is live —
          forward-looking, after commission, region-scoped. Until then these tiles are intentionally blank rather than showing a fabricated zero.
        </p>
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOperatorPage(ctx); // ANY operator (Dashboard is all-roles); wrong class → 404
  if (!gate.ok) return { notFound: true };
  const tenantCount = await prisma.group.count({ where: operatorTenantScope(gate.op) }); // region-scoped, real
  const scopeLabel = gate.op.role === 'owner' ? 'all regions' : (gate.op.regions.length ? gate.op.regions.join(', ') : 'none');
  return { props: { role: gate.op.role, scopeLabel, tenantCount } };
};
