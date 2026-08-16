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

type PageProps = { role: OperatorRoleName; scopeLabel: string; tenantCount: number; unaccrued: number };

function ComingTile({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="text-sm text-slate-400">{title}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-500">—</div>
      <div className="mt-1 text-xs text-slate-500">{note}</div>
    </div>
  );
}

export default function EngineRoomDashboard({ role, scopeLabel, tenantCount, unaccrued }: PageProps) {
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

          {/* ── COMMISSION THAT DID NOT ACCRUE ────────────────────────────────────────────────
              A REAL figure, unlike the two tiles above, because this one can be wrong right now.
              Zero is stated rather than blanked: "none outstanding" is a fact worth showing, and
              a tile that only appears when something is broken is a tile nobody learns to read. */}
          <div className={`rounded-xl border p-5 ${unaccrued > 0 ? 'border-amber-700/70 bg-amber-950/40' : 'border-slate-800 bg-slate-900'}`}
            data-testid="er-unaccrued-tile">
            <div className={`text-sm ${unaccrued > 0 ? 'text-amber-200' : 'text-slate-400'}`}>Commission not accrued</div>
            <div className={`mt-2 text-2xl font-semibold tabular-nums ${unaccrued > 0 ? 'text-amber-100' : 'text-white'}`}
              data-testid="er-unaccrued-count">{unaccrued}</div>
            <div className={`mt-1 text-xs ${unaccrued > 0 ? 'text-amber-200/80' : 'text-slate-500'}`}>
              {unaccrued > 0
                ? 'Payments the engine refused to accrue — a rep is owed and unpaid. Open the tenant to see why.'
                : 'No refused accruals outstanding.'}
            </div>
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
  // Region-scoped AND customer-only: internal (GreaseDesk-owned gate/test) tenants never count toward
  // the headline tenant figure or the forecast built from it.
  const tenantCount = await prisma.group.count({ where: { ...operatorTenantScope(gate.op), is_internal: { not: true } } });
  // OPEN refusals only, and scoped through the GROUP so a country manager sees their own region's
  // problem and not somebody else's. `is_internal` is NOT excluded here — unlike the headline
  // tenant count, a gate tenant failing to accrue is still a real defect worth seeing.
  const unaccrued = await (prisma as any).commissionRefusal.count({
    where: { resolved_at: null, group: { ...operatorTenantScope(gate.op) } },
  });
  const scopeLabel = gate.op.role === 'owner' ? 'all regions' : (gate.op.regions.length ? gate.op.regions.join(', ') : 'none');
  return { props: { role: gate.op.role, scopeLabel, tenantCount, unaccrued } };
};
