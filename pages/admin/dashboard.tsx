/**
 * File: pages/admin/dashboard.tsx
 * The admin dashboard — a PLATFORM of period-aware tiles, not a fixed page. The server computes
 * every registered tile (lib/dashboard-tiles — add a compute there) over the caller's visible
 * sites; this page holds the matching CLIENT registry (TILE_RENDERERS — add a renderer here).
 * Registering both IS adding a tile; the grid and the period plumbing never change.
 * Period: Xero-style presets (FY-aware via the tenant's fy_start_month) + custom range —
 * dashboard-wide, all tiles recompute together. Manager sees only their sites' figures
 * (server-scoped); STANDARD is redirected to the diary (money surface, same rule as landing).
 */
import React, { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { getVisibility } from '@/lib/site-visibility';
import { daysLeft } from '@/lib/trial';
import { formatMoney } from '@/lib/format-money';
import { withI18n } from '@/lib/gssp-i18n';
import { PERIOD_PRESETS, PeriodPreset } from '@/lib/dashboard-periods';

type PageProps = {
  groupName: string; accountRef: string; status: string; trialEndsAt: string | null;
  currency: string; locale: string;
};

// ---------- Tile framework (client side) ----------
// A renderer receives its tile's server data + shared formatting context. Adding a tile = one
// entry here + one compute in lib/dashboard-tiles.ts. Order here is display order.
type Fmt = { money: (p: number) => string; t: (k: string, o?: any) => string };
type TileRenderer = { key: string; render: (data: any, f: Fmt) => React.ReactNode };

const TILE_RENDERERS: TileRenderer[] = [
  {
    key: 'revenue',
    render: (d, f) => (
      <>
        <p className="text-3xl font-bold text-ink tabular-nums">{f.money(d.grossPennies)}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.revenueSub', { count: d.count })}</p>
        {d.perSite?.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {d.perSite.map((s: any) => (
              <div key={s.site} className="flex justify-between text-xs"><span className="text-muted">{s.site}</span><span className="text-ink tabular-nums">{f.money(s.grossPennies)}</span></div>
            ))}
          </div>
        )}
      </>
    ),
  },
  {
    key: 'issuedVsPaid',
    render: (d, f) => (
      <div className="space-y-1.5">
        <div className="flex justify-between items-baseline"><span className="text-xs text-muted">{f.t('tiles.issued')}</span><span className="text-lg font-semibold text-ink tabular-nums">{d.issuedCount} · {f.money(d.issuedPennies)}</span></div>
        <div className="flex justify-between items-baseline"><span className="text-xs text-muted">{f.t('tiles.paid')}</span><span className="text-lg font-semibold text-ok tabular-nums">{d.paidCount} · {f.money(d.paidPennies)}</span></div>
      </div>
    ),
  },
  {
    key: 'pendingClearance',
    render: (d, f) => (
      <>
        <p className="text-3xl font-bold text-warn tabular-nums">{f.money(d.grossPennies)}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.pendingClearanceSub', { count: d.count })}</p>
      </>
    ),
  },
  {
    key: 'debtors',
    render: (d, f) => (
      <>
        <p className="text-3xl font-bold text-warn tabular-nums">{f.money(d.grossPennies)}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.debtorsSub', { count: d.count })}</p>
      </>
    ),
  },
  {
    key: 'warranty',
    render: (d, f) => (
      <>
        <p className="text-3xl font-bold text-ink tabular-nums">{d.count}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.warrantySub')}</p>
      </>
    ),
  },
];

function TrialBanner({ status, trialEndsAt }: { status: string; trialEndsAt: string | null }) {
  let text: string;
  let tone = 'bg-surface border-line text-ink';
  if (status !== 'trial') {
    text = `Account status: ${status}`;
    if (status === 'active') tone = 'bg-ok-soft border-line text-ok';
    else if (status === 'suspended' || status === 'cancelled') tone = 'bg-danger-soft border-line text-danger';
  } else {
    const d = daysLeft(trialEndsAt);
    if (d == null) text = 'Trial active';
    else if (d > 0) { text = `${d} day${d === 1 ? '' : 's'} left in your trial`; tone = 'bg-accent-soft border-accent text-accent'; }
    else { text = 'Trial ended'; tone = 'bg-warn-soft border-warn text-warn'; }
  }
  return <div className={`rounded-xl border p-4 mb-6 ${tone}`}>{text}</div>;
}

export default function AdminDashboard(props: PageProps) {
  const { t } = useTranslation('dashboard');
  const [preset, setPreset] = useState<PeriodPreset | 'custom'>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [tiles, setTiles] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const qs = preset === 'custom'
      ? (customFrom && customTo ? `from=${customFrom}&to=${customTo}` : null)
      : `preset=${preset}`;
    if (!qs) return; // custom picked but incomplete — wait for both dates
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard-tiles?${qs}`, { cache: 'no-store' });
      if (res.ok) setTiles((await res.json()).tiles);
    } catch { /* tiles keep last values */ }
    setLoading(false);
  }, [preset, customFrom, customTo]);
  useEffect(() => { load(); }, [load]);

  const fmt: Fmt = { money: (p) => formatMoney(p, { currency: props.currency, locale: props.locale }), t };

  return (
    <>
      <Head><title>{t('title')} - GreaseDesk</title></Head>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select value={preset} onChange={(e) => setPreset(e.target.value as any)}
            className="p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent">
            {PERIOD_PRESETS.map((p) => <option key={p} value={p}>{t(`period.${p}`)}</option>)}
            <option value="custom">{t('period.custom')}</option>
          </select>
          {preset === 'custom' && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
              <span className="text-muted text-sm">→</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
            </>
          )}
        </div>
      </div>
      <p className="text-muted mb-5">{props.groupName} · <span className="font-mono">{props.accountRef}</span></p>

      <TrialBanner status={props.status} trialEndsAt={props.trialEndsAt} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {TILE_RENDERERS.map(({ key, render }) => (
          <div key={key} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
            <h2 className="text-sm font-semibold text-muted mb-2">{t(`tiles.${key}`)}</h2>
            {tiles?.[key] != null ? render(tiles[key], fmt) : <p className="text-sm text-muted">{loading ? t('loading') : '—'}</p>}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted mt-3">{t('footnote')}</p>
    </>
  );
}

export const getServerSideProps = withI18n(['dashboard'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }
  // Money surface: manager/admin only — STANDARD goes to their diary (same rule as landing).
  const vis = await getVisibility(user.id as string);
  if (!(vis.isAdmin || vis.role === 'SITE_MANAGER')) {
    const site = vis.primarySiteId ?? vis.siteIds[0] ?? null;
    return { redirect: { destination: site ? `/admin/diary?site=${encodeURIComponent(site)}` : '/admin/diary', permanent: false } };
  }
  const group = (await prisma.group.findUnique({
    where: { id: user.group_id },
    select: { group_name: true, ref: true, status: true, trial_ends_at: true },
  })) as { group_name: string; ref: string; status: string; trial_ends_at: Date | null } | null;
  const site = vis.primarySiteId
    ? ((await prisma.site.findUnique({ where: { id: vis.primarySiteId }, select: { currency_code: true, locale: true } })) as { currency_code: string; locale: string } | null)
    : null;

  return {
    props: {
      groupName: group?.group_name ?? 'Your garage',
      accountRef: group?.ref ?? '—',
      status: group?.status ?? 'trial',
      trialEndsAt: group?.trial_ends_at ? group.trial_ends_at.toISOString() : null,
      currency: site?.currency_code ?? 'GBP',
      locale: site?.locale ?? 'en-GB',
    },
  };
});
