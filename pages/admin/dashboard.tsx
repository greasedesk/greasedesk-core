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
import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { getVisibility } from '@/lib/site-visibility';
import { daysLeft } from '@/lib/trial';
import { formatMoney } from '@/lib/format-money';
import { withI18n } from '@/lib/gssp-i18n';
import { PERIOD_PRESETS, PeriodPreset, monthParamsForSelection } from '@/lib/dashboard-periods';

type PageProps = {
  groupName: string; accountRef: string; status: string; trialEndsAt: string | null;
  currency: string; locale: string;
};

// ---------- Tile framework (client side) ----------
// A renderer receives its tile's server data + shared formatting context. Adding a tile = one
// entry here + one compute in lib/dashboard-tiles.ts. Order here is display order.
// qs = the CURRENT cash-period querystring (preset=… or from=…&to=…) — period-scoped tiles append
// it to their Invoices link so the list opens on the same calendar; point-in-time tiles ignore it.
type Fmt = { money: (p: number) => string; t: (k: string, o?: any) => string; qs: string | null };
// pointInTime marks tiles that DELIBERATELY ignore the period selector (locked rule: pending
// clearance + debtors are current-state). The grid gives them an unmistakable "As of today"
// badge + dashed card treatment and groups them AFTER the period tiles — the footnote is no
// longer the only carrier of the distinction.
// A clickable tile face: fills the tile (the wrapper has p-5), hover affordance reads as a link.
const tileLink = 'block -m-3 p-3 rounded-lg hover:bg-surface-muted/60 cursor-pointer transition-colors';
type TileRenderer = { key: string; pointInTime?: boolean; render: (data: any, f: Fmt) => React.ReactNode };

const TILE_RENDERERS: TileRenderer[] = [
  {
    key: 'revenue',
    render: (d, f) => (
      <Link href={`/admin/invoices?status=paid${f.qs ? `&${f.qs}` : ''}`} className={tileLink}>
        <p className="text-3xl font-bold text-ink tabular-nums">{f.money(d.grossPennies)}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.revenueSub', { count: d.count })}</p>
        {d.perSite?.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {d.perSite.map((s: any) => (
              <div key={s.site} className="flex justify-between text-xs"><span className="text-muted">{s.site}</span><span className="text-ink tabular-nums">{f.money(s.grossPennies)}</span></div>
            ))}
          </div>
        )}
      </Link>
    ),
  },
  {
    key: 'issuedVsPaid',
    // SPLIT-clickable: each half is its own link (Issued → the arrival-only 'issued' filter:
    // chargeable issued-in-period, any status; Paid → the same list the Revenue tile opens).
    render: (d, f) => (
      <div className="space-y-1.5">
        <Link href={`/admin/invoices?status=issued${f.qs ? `&${f.qs}` : ''}`} className="flex justify-between items-baseline rounded-md -mx-1.5 px-1.5 hover:bg-surface-muted/60 cursor-pointer transition-colors">
          <span className="text-xs text-muted">{f.t('tiles.issued')}</span><span className="text-lg font-semibold text-ink tabular-nums">{d.issuedCount} · {f.money(d.issuedPennies)}</span>
        </Link>
        <Link href={`/admin/invoices?status=paid${f.qs ? `&${f.qs}` : ''}`} className="flex justify-between items-baseline rounded-md -mx-1.5 px-1.5 hover:bg-surface-muted/60 cursor-pointer transition-colors">
          <span className="text-xs text-muted">{f.t('tiles.paid')}</span><span className="text-lg font-semibold text-ok tabular-nums">{d.paidCount} · {f.money(d.paidPennies)}</span>
        </Link>
      </div>
    ),
  },
  {
    key: 'warranty',
    render: (d, f) => (
      <Link href={`/admin/invoices?status=warranty${f.qs ? `&${f.qs}` : ''}`} className={tileLink}>
        <p className="text-3xl font-bold text-ink tabular-nums">{d.count}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.warrantySub')}</p>
      </Link>
    ),
  },
  {
    key: 'pendingClearance',
    pointInTime: true, // current clearance window — ignores the period selector BY DESIGN
    render: (d, f) => (
      <Link href="/admin/invoices?status=pending" className={tileLink}>
        <p className="text-3xl font-bold text-warn tabular-nums">{f.money(d.grossPennies)}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.pendingClearanceSub', { count: d.count })}</p>
      </Link>
    ),
  },
  {
    key: 'debtors',
    pointInTime: true, // current outstanding — ignores the period selector BY DESIGN
    render: (d, f) => (
      <Link href="/admin/invoices?status=unpaid" className={tileLink}>
        <p className="text-3xl font-bold text-warn tabular-nums">{f.money(d.grossPennies)}</p>
        <p className="text-xs text-muted mt-1">{f.t('tiles.debtorsSub', { count: d.count })}</p>
      </Link>
    ),
  },
];

// "June 2026" for one month; "Apr 2026 – Mar 2027" for a span. monthTo is exclusive.
function monthLabel(w: { from: string; to: string }, locale: string): string {
  const from = new Date(w.from);
  const lastIncl = new Date(new Date(w.to).getTime() - 86_400_000);
  const one = from.getUTCFullYear() === lastIncl.getUTCFullYear() && from.getUTCMonth() === lastIncl.getUTCMonth();
  const f = (d: Date, style: 'long' | 'short') => d.toLocaleDateString(locale, { month: style, year: 'numeric', timeZone: 'UTC' });
  return one ? f(from, 'long') : `${f(from, 'short')} – ${f(lastIncl, 'short')}`;
}

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
  // The month window the SERVER resolved for the P&L (echoed back) — drives the loud label.
  const [monthWindow, setMonthWindow] = useState<{ from: string; to: string } | null>(null);
  const [loading, setLoading] = useState(true);
  // ONE period control drives BOTH strips. The P&L stays whole-calendar-months only: it follows
  // whole-month selections exactly; part-periods (to-dates / partial custom) fall back to the
  // CONTAINING calendar month with a plain on-screen notice — never a silent mismatch, and
  // never pro-rated wages to fake a part-period (see lib/dashboard-periods).
  const monthSel = monthParamsForSelection(preset, customFrom, customTo);

  // The cash strip's period as a querystring — ONE builder shared by the tiles fetch and the
  // tile links, so a click lands on exactly the period the tile displayed.
  const cashQS = preset === 'custom'
    ? (customFrom && customTo ? `from=${customFrom}&to=${customTo}` : null)
    : `preset=${preset}`;
  const monthQS = monthSel
    ? (monthSel.mpreset ? `mpreset=${monthSel.mpreset}` : `mfrom=${monthSel.mfrom}&mto=${monthSel.mto}`)
    : null;
  const load = useCallback(async () => {
    if (!cashQS || !monthQS) return; // custom picked but incomplete — wait for both ends
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard-tiles?${cashQS}&${monthQS}`, { cache: 'no-store' });
      if (res.ok) {
        const d = await res.json();
        setTiles(d.tiles);
        setMonthWindow(d.monthFrom && d.monthTo ? { from: d.monthFrom, to: d.monthTo } : null);
      }
    } catch { /* tiles keep last values */ }
    setLoading(false);
  }, [cashQS, monthQS]);
  useEffect(() => { load(); }, [load]);

  const fmt: Fmt = { money: (p) => formatMoney(p, { currency: props.currency, locale: props.locale }), t, qs: cashQS };

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
        {TILE_RENDERERS.map(({ key, render, pointInTime }) => (
          <div key={key} className={`bg-surface p-5 rounded-xl border ${pointInTime ? 'border-dashed border-accent' : 'border-line'} ${loading ? 'opacity-60' : ''}`}>
            <h2 className="text-sm font-semibold text-muted mb-2 flex items-center justify-between gap-2">
              <span>{t(`tiles.${key}`)}</span>
              {pointInTime && <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 bg-accent text-white">{t('tiles.rightNow')}</span>}
            </h2>
            {tiles?.[key] != null ? render(tiles[key], fmt) : <p className="text-sm text-muted">{loading ? t('loading') : '—'}</p>}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted mt-3">{t('footnote')}</p>

      {/* ---- P&L strip: month-grained BY DESIGN — follows the ONE period control above. The
           resolved month window renders LOUD so the strip can never be misread against the cash
           tiles; part-period selections show the containing-month notice instead of a silent
           substitute. ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-8 mb-3">
        <div>
          <h2 className="text-lg font-bold text-ink">{t('pnl.title')}</h2>
          <p className="text-xs text-muted">{t('pnl.monthlyNote')}</p>
        </div>
        {monthWindow && (
          <span className="text-base font-semibold text-ink bg-surface-muted border border-line rounded-lg px-3 py-1.5">
            {monthLabel(monthWindow, props.locale)}
          </span>
        )}
      </div>
      {monthSel?.degraded && monthWindow && (
        <p className="text-sm text-warn bg-warn-soft border border-warn rounded-lg px-3 py-2 mb-3">
          {t('pnl.degradedNote', { label: monthLabel(monthWindow, props.locale) })}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {(['revenueNet', 'partsCost', 'grossMargin', 'hoursCharged', 'labourContribution', 'netProfit'] as const).map((k) => {
          const d = tiles?.pnl as any;
          if (k === 'hoursCharged') {
            const hrs = d?.hoursChargedCentihours;
            return (
              <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
                <h3 className="text-sm font-semibold text-muted mb-2">{t('pnl.hoursCharged')}</h3>
                {hrs != null ? (
                  <>
                    <p className="text-2xl font-bold tabular-nums text-ink">{(hrs / 100).toLocaleString(props.locale, { maximumFractionDigits: 2 })}h</p>
                    <p className="text-xs text-muted mt-1">
                      {t('pnl.hoursChargedSub')}
                      {d?.linesMissingHours > 0 && <span className="text-warn"> · {t('pnl.hoursMissing', { count: d.linesMissingHours })}</span>}
                    </p>
                  </>
                ) : <p className="text-sm text-muted">{loading ? t('loading') : '—'}</p>}
              </div>
            );
          }
          const v = d?.[k];
          const tone = v == null ? 'text-muted' : (k === 'netProfit' || k === 'labourContribution') ? (v >= 0 ? 'text-ok' : 'text-danger') : 'text-ink';
          return (
            <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
              <h3 className="text-sm font-semibold text-muted mb-2">{t(`pnl.${k}`)}</h3>
              {v != null ? (
                <>
                  <p className={`text-2xl font-bold tabular-nums ${tone}`}>{fmt.money(v)}</p>
                  <p className="text-xs text-muted mt-1">{t(`pnl.${k}Sub`, {
                    parts: d ? fmt.money(d.partsCost) : '', wages: d ? fmt.money(d.wageBill) : '', income: d ? fmt.money(d.grossMargin) : '',
                    overheads: d ? fmt.money(d.operatingCosts) : '', count: d?.invoiceCount ?? 0, months: d?.months ?? 0,
                  })}</p>
                </>
              ) : <p className="text-sm text-muted">{loading ? t('loading') : '—'}</p>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted mt-3">{t('pnl.honesty')}</p>
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
