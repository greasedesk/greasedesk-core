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
import { NOT_OURS } from '@/lib/tenant-population';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type PageProps = { role: OperatorRoleName; scopeLabel: string; tenantCount: number; unaccrued: number };

function ComingTile({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="text-sm text-muted">{title}</div>
      <div className="mt-2 text-2xl font-semibold text-muted">—</div>
      <div className="mt-1 text-xs text-muted">{note}</div>
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
          <span className="text-xs text-muted">scope: {scopeLabel} · {role.replace('_', ' ')}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* ── NO REVENUE TILE, DELIBERATELY. ───────────────────────────────────────────────
              It used to say "Arrives when billing goes live." Billing has BEEN live, on live keys,
              with paying tenants — so the note had outlived its premise and read as a broken
              feature rather than an unbuilt one.
              It is removed rather than computed because NOTHING IN THIS DATABASE RECORDS A
              COLLECTED PAYMENT. StripeEvent is a dedupe ledger (event_id, type, livemode,
              processed_at — no amounts), and CommissionEntry.amount_pennies is the REP's share,
              which exists only for attributed tenants. A tile built from either would under-report
              and look authoritative. Boarded: record collected payments, then build the tile on
              the record. A missing tile asks the question; a wrong one answers it. ── */}
          <ComingTile title="Retained revenue (forecast)" note="After commission — reads the commission engine once rates & payments are live." />
          <div className="rounded-xl border border-line bg-surface p-5">
            <div className="text-sm text-muted">Tenants in scope</div>
            <div className="mt-2 text-2xl font-semibold text-ink tabular-nums" data-testid="er-tenant-count">{tenantCount}</div>
            <div className="mt-1 text-xs text-muted">Region-scoped to your access.</div>
          </div>

          {/* ── COMMISSION THAT DID NOT ACCRUE ────────────────────────────────────────────────
              A REAL figure, unlike the two tiles above, because this one can be wrong right now.
              Zero is stated rather than blanked: "none outstanding" is a fact worth showing, and
              a tile that only appears when something is broken is a tile nobody learns to read. */}
          <div className={`rounded-xl border p-5 ${unaccrued > 0 ? 'border-warn bg-warn-soft' : 'border-line bg-surface'}`}
            data-testid="er-unaccrued-tile">
            <div className={`text-sm ${unaccrued > 0 ? 'text-warn' : 'text-muted'}`}>Commission not accrued</div>
            <div className={`mt-2 text-2xl font-semibold tabular-nums ${unaccrued > 0 ? 'text-warn' : 'text-ink'}`}
              data-testid="er-unaccrued-count">{unaccrued}</div>
            <div className={`mt-1 text-xs ${unaccrued > 0 ? 'text-warn' : 'text-muted'}`}>
              {unaccrued > 0
                ? 'Payments the engine refused to accrue — a rep is owed and unpaid. Open the tenant to see why.'
                : 'No refused accruals outstanding.'}
            </div>
          </div>
        </div>
        <p className="mt-6 text-sm text-muted">
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
  // NOT_OURS, not `{ not: true }`. This tile read ZERO on 2026-10-31 with every garage on the
  // platform a paying customer: Prisma compiles `{ not: true }` to `"is_internal" <> $1`, and NULL
  // sits outside that just as it sits outside `= false`. Measured on the gate database — `{ not:
  // true }` returned 0 where this predicate returned 4, against 4 NULL / 2 true / 0 false. The
  // predicate is a leaf import so a page can take it without dragging the alert spine in.
  const tenantCount = await prisma.group.count({ where: { AND: [operatorTenantScope(gate.op), NOT_OURS] } });
  // OPEN refusals only, and scoped through the GROUP so a country manager sees their own region's
  // problem and not somebody else's. `is_internal` is NOT excluded here — unlike the headline
  // tenant count, a gate tenant failing to accrue is still a real defect worth seeing.
  const unaccrued = await (prisma as any).commissionRefusal.count({
    where: { resolved_at: null, group: { ...operatorTenantScope(gate.op) } },
  });
  const scopeLabel = gate.op.role === 'owner' ? 'all regions' : (gate.op.regions.length ? gate.op.regions.join(', ') : 'none');
  return { props: { role: gate.op.role, scopeLabel, tenantCount, unaccrued } };
};
