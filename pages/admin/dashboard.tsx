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
  sites: Array<{ id: string; name: string }>; // the caller's VISIBLE sites (server-resolved)
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
  // Site scope — sibling of the period control, scopes the ENTIRE dashboard (both strips).
  // 'all' = the group-aggregate default; options are the server-resolved visible sites only
  // (the API re-checks canAccessSite — this dropdown is decoration, not the control).
  const [siteId, setSiteId] = useState<'all' | string>('all');
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
  const siteQS = siteId === 'all' ? '' : `&site=${siteId}`;
  const load = useCallback(async () => {
    if (!cashQS || !monthQS) return; // custom picked but incomplete — wait for both ends
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard-tiles?${cashQS}&${monthQS}${siteQS}`, { cache: 'no-store' });
      if (res.ok) {
        const d = await res.json();
        setTiles(d.tiles);
        setMonthWindow(d.monthFrom && d.monthTo ? { from: d.monthFrom, to: d.monthTo } : null);
      }
    } catch { /* tiles keep last values */ }
    setLoading(false);
  }, [cashQS, monthQS, siteQS]);
  useEffect(() => { load(); }, [load]);

  const fmt: Fmt = { money: (p) => formatMoney(p, { currency: props.currency, locale: props.locale }), t, qs: cashQS };

  return (
    <>
      <Head><title>{t('title')} - GreaseDesk</title></Head>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-bold text-ink">{t('title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {props.sites.length > 1 && (
            <select value={siteId} onChange={(e) => setSiteId(e.target.value as any)}
              className="p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent">
              <option value="all">{t('allSites')}</option>
              {props.sites.map((s2) => <option key={s2.id} value={s2.id}>{s2.name}</option>)}
            </select>
          )}
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
      {siteId !== 'all' && tiles && (tiles.pnl as any)?.invoiceCount === 0 && (tiles.utilisation as any)?.mechanicCount === 0 && ((tiles.utilisation as any)?.missingHoursMechanics?.length ?? 0) === 0 && (
        <div className="rounded-xl border border-line bg-surface-muted p-3 mb-4 text-sm text-muted">
          {t('notTrading', { site: props.sites.find((s2) => s2.id === siteId)?.name ?? '' })}
        </div>
      )}

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
        {(['revenueNet', 'partsCost', 'grossMargin', 'hoursCharged', 'labourContribution', 'netProfit', 'costBase', 'breakEven', 'utilisation', 'hoursWent', 'unsold'] as const).map((k) => {
          const d = tiles?.pnl as any;
          if (k === 'hoursWent' || k === 'unsold') {
            const u3 = tiles?.utilisation as any;
            const cb3 = tiles?.costBase as any;
            const h3 = (n: number) => `${n.toLocaleString(props.locale, { maximumFractionDigits: 2 })}h`;
            if (u3 == null) return (
              <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
                <h3 className="text-sm font-semibold text-muted mb-2">{t(`pnl.${k}`)}</h3>
                <p className="text-sm text-muted">{loading ? t('loading') : '—'}</p>
              </div>
            );
            // Unsold = SELLABLE − charged: realistically sellable capacity that went unsold, not
            // raw clock time (leave/PH shrink raw hours; the factor then discounts raw to sellable).
            const unsold = Math.max(0, u3.available - u3.charged);
            const overtime = u3.charged > u3.available;
            // Unsold in money: per-site unsold × that site's rate (from the costBase compute —
            // same rate read as break-even; rate-less sites with unsold hours are FLAGGED).
            let unsoldPennies = 0; const noRate: string[] = [];
            if (cb3) for (const s3 of u3.perSite) {
              const su = Math.max(0, s3.available - s3.charged);
              if (su <= 0) continue;
              const rate = cb3.perSite.find((r3: any) => r3.siteId === s3.siteId)?.ratePounds ?? null;
              if (rate == null) noRate.push(s3.siteName);
              else unsoldPennies += Math.round(su * rate * 100);
            }
            if (k === 'hoursWent') {
              const types = Object.entries((u3.leaveByType ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]);
              return (
                <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
                  <h3 className="text-sm font-semibold text-muted mb-2">{t('pnl.hoursWent')}</h3>
                  {/* HEADLINE = the ABSENCE total (the actionable figure) — gross capacity is the
                      least actionable number in the chain and lives in the drill. 0 renders as
                      a clean 0h, never a dash. */}
                  <p className="text-2xl font-bold tabular-nums text-ink">{h3(Math.round((u3.leaveHours + u3.phHours) * 100) / 100)}</p>
                  <p className="text-xs text-muted mt-1">{t('pnl.hoursWentSub')}</p>
                  <details className="mt-2" open={false}>
                    <summary className="text-xs text-accent cursor-pointer">{t('pnl.utilHow')}</summary>
                    <div className="text-xs text-muted mt-1 space-y-0.5">
                      {/* Order is binding: absence reduces RAW clock time; the factor discounts
                          what remains — never the other way round (no double-count). */}
                      <p>{t('pnl.wfGross', { gross: h3(u3.grossHours) })}</p>
                      {u3.phHours > 0 && <p>− {h3(u3.phHours)} {t('pnl.wfPh')}</p>}
                      {types.map(([ty, hh]) => <p key={ty}>− {h3(hh)} {t(`pnl.leaveType.${ty}`)}</p>)}
                      <p className="text-ink">= {h3(u3.rawHours)} {t('pnl.wfRaw')}</p>
                      <p>{t('pnl.wfFactor', { sellable: h3(u3.available) })}</p>
                      <p>− {h3(u3.charged)} {t('pnl.wfCharged')}</p>
                      <p className="text-ink font-medium">= {h3(unsold)} {t('pnl.wfUnsold')}</p>
                      <p className="italic mt-1">{t('pnl.wfFraming')}</p>
                    </div>
                  </details>
                </div>
              );
            }
            return (
              <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
                <h3 className="text-sm font-semibold text-muted mb-2">{t('pnl.unsold')}</h3>
                {overtime ? (
                  <>
                    <p className="text-2xl font-bold tabular-nums text-ok">{t('pnl.unsoldOvertime')}</p>
                    <p className="text-xs text-muted mt-1">{t('pnl.unsoldOvertimeSub', { charged: h3(u3.charged), available: h3(u3.available) })}</p>
                  </>
                ) : (
                  <>
                    <p className="text-2xl font-bold tabular-nums text-ink">{h3(unsold)}</p>
                    <p className="text-xs text-muted mt-1">{unsoldPennies > 0 ? t('pnl.unsoldSub', { money: fmt.money(unsoldPennies) }) : t('pnl.unsoldSubNoMoney')}</p>
                    {noRate.length > 0 && <p className="text-xs text-warn mt-1">{t('pnl.breakEvenNoRate', { sites: noRate.join(', ') })}</p>}
                  </>
                )}
                <details className="mt-2">
                  <summary className="text-xs text-accent cursor-pointer">{t('pnl.utilHow')}</summary>
                  <div className="text-xs text-muted mt-1 space-y-1">
                    <p>{t('pnl.unsoldCalc', { available: h3(u3.available), charged: h3(u3.charged), unsold: h3(unsold), money: unsoldPennies > 0 ? fmt.money(unsoldPennies) : '—' })}</p>
                    <p className="italic">{t('pnl.unsoldHonesty')}</p>
                  </div>
                </details>
              </div>
            );
          }
          if (k === 'costBase' || k === 'breakEven') {
            const cb = tiles?.costBase as any;
            const u2 = tiles?.utilisation as any;
            const hrs = (c: number | null) => (c == null ? '—' : `${(c / 100).toLocaleString(props.locale, { maximumFractionDigits: 1 })}h`);
            return (
              <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
                <h3 className="text-sm font-semibold text-muted mb-2">{t(`pnl.${k}`)}</h3>
                {cb == null ? <p className="text-sm text-muted">{loading ? t('loading') : '—'}</p> : k === 'costBase' ? (
                  <>
                    <p className="text-2xl font-bold tabular-nums text-ink">{fmt.money(cb.costBasePennies)}</p>
                    <p className="text-xs text-muted mt-1">{t('pnl.costBaseSub')}</p>
                    <details className="mt-2">
                      <summary className="text-xs text-accent cursor-pointer">{t('pnl.utilHow')}</summary>
                      <p className="text-xs text-muted mt-1">{t('pnl.costBaseCalc', { wages: fmt.money(cb.wageBillPennies), overheads: fmt.money(cb.overheadsPennies), total: fmt.money(cb.costBasePennies) })}</p>
                    </details>
                  </>
                ) : (
                  (() => {
                    // Break-even (pure-labour headline). Residual refinement + BE revenue are
                    // DISPLAY divisions of chokepoint numbers — guarded, never NaN/Infinity.
                    const d2 = tiles?.pnl as any;
                    const marginRate = d2 && d2.revenueNet > 0 ? d2.grossMargin / d2.revenueNet : null;
                    const beRevenue = marginRate && marginRate > 0 ? Math.round(cb.costBasePennies / marginRate) : null;
                    const rate = cb.perSite.find((s2: any) => s2.ratePounds != null)?.ratePounds ?? null;
                    const residual = d2 && rate ? Math.max(0, cb.costBasePennies - Math.max(0, d2.grossMargin - Math.round((d2.hoursChargedCentihours / 100) * rate * 100))) : null;
                    const residualHours = residual != null && rate ? residual / (rate * 100) : null;
                    return (
                      <>
                        <p className="text-2xl font-bold tabular-nums text-ink">{cb.breakEvenCentihours > 0 ? hrs(cb.breakEvenCentihours) : '—'}</p>
                        <p className="text-xs text-muted mt-1">{t('pnl.breakEvenSub')}</p>
                        {cb.ratesMissing.length > 0 && <p className="text-xs text-warn mt-1">{t('pnl.breakEvenNoRate', { sites: cb.ratesMissing.join(', ') })}</p>}
                        <details className="mt-2">
                          <summary className="text-xs text-accent cursor-pointer">{t('pnl.utilHow')}</summary>
                          <div className="text-xs text-muted mt-1 space-y-1">
                            {cb.perSite.filter((s2: any) => s2.costBasePennies > 0).map((s2: any) => (
                              <p key={s2.siteId}>{s2.siteName}: {fmt.money(s2.costBasePennies)} ÷ {s2.ratePounds != null ? `£${s2.ratePounds}/h` : '—'} = {hrs(s2.breakEvenCentihours)}</p>
                            ))}
                            <p>{t('pnl.breakEvenRevenue', { value: beRevenue != null ? fmt.money(beRevenue) : '—' })}</p>
                            {/* Expressed against SELLABLE capacity (factor-adjusted) — the same
                                denominator the utilisation tile uses. */}
                            {u2 && u2.available > 0 && cb.breakEvenCentihours > 0 && (
                              <p>{t('pnl.breakEvenOfSellable', { pct: `${(((cb.breakEvenCentihours / 100) / u2.available) * 100).toLocaleString(props.locale, { maximumFractionDigits: 1 })}%` })}</p>
                            )}
                            {residualHours != null && <p>{t('pnl.breakEvenResidual', { hours: residualHours.toLocaleString(props.locale, { maximumFractionDigits: 1 }) })}</p>}
                            <p className="italic">{t('pnl.breakEvenHonesty')}</p>
                          </div>
                        </details>
                      </>
                    );
                  })()
                )}
              </div>
            );
          }
          if (k === 'utilisation') {
            const u = tiles?.utilisation as any;
            const pct = (r: number | null) => (r == null ? '—' : `${(r * 100).toLocaleString(props.locale, { maximumFractionDigits: 1 })}%`);
            const h = (n: number) => `${n.toLocaleString(props.locale, { maximumFractionDigits: 2 })}h`;
            return (
              <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
                <h3 className="text-sm font-semibold text-muted mb-2">{t('pnl.utilisation')}</h3>
                {u == null ? <p className="text-sm text-muted">{loading ? t('loading') : '—'}</p>
                  /* Display-state precedence: set-up → zero-available → number (amber when incomplete). */
                  : (u.mechanicCount === 0 && u.missingHoursMechanics.length === 0) ? (
                    <p className="text-sm text-muted">
                      {t('pnl.utilSetup')}{' '}
                      <Link href="/admin/hr" className="text-accent underline">{t('pnl.utilSetupLink')}</Link>
                    </p>
                  ) : u.available === 0 ? (
                    <>
                      <p className="text-2xl font-bold tabular-nums text-muted">—</p>
                      <p className="text-xs text-muted mt-1">{t('pnl.utilZeroAvail')}</p>
                    </>
                  ) : (
                    <>
                      {/* The factor is baked into the denominator — 100% IS the target by
                          construction, so no separate target line may reappear here. */}
                      <p className="text-2xl font-bold tabular-nums text-ink">{pct(u.ratio)}</p>
                      <p className="text-xs text-ink mt-0.5">{t('pnl.utilHundred')}</p>
                      <p className="text-xs text-muted mt-1">{t('pnl.utilSub', { charged: h(u.charged), available: h(u.available) })}</p>
                      {(() => {
                        // The money floor: required share of SELLABLE capacity to cover fixed costs.
                        const cb2 = tiles?.costBase as any;
                        if (!cb2 || !(u.available > 0) || !(cb2.breakEvenCentihours > 0)) return null;
                        const req = (cb2.breakEvenCentihours / 100) / u.available;
                        return <p className="text-xs text-ink mt-1">{t('pnl.utilTarget', { pct: `${(req * 100).toLocaleString(props.locale, { maximumFractionDigits: 1 })}%` })}</p>;
                      })()}
                      {!u.configComplete && (
                        <p className="text-xs text-warn mt-1">{t('pnl.utilMissing', { count: u.missingHoursMechanics.length })}</p>
                      )}
                      {/* The arithmetic, in place: rostered − leave − PH = raw; × factor = sellable;
                          charged ÷ sellable = utilisation. */}
                      <details className="mt-2">
                        <summary className="text-xs text-accent cursor-pointer">{t('pnl.utilHow')}</summary>
                        <div className="text-xs text-muted mt-1 space-y-1">
                          <p>{t('pnl.utilCalc', { mechanics: u.mechanicCount, days: u.rosteredDays, leave: h(u.leaveHours), ph: h(u.phHours), raw: h(u.rawHours), available: h(u.available), charged: h(u.charged), pct: pct(u.ratio) })}</p>
                          {(u.factorParts?.length ?? 0) > 0 && (
                            <>
                              <p className="text-ink mt-1">{t('pnl.utilFactorHeading')}</p>
                              {u.factorParts.map((fp: any, i2: number) => (
                                <p key={i2}>{fp.name}: {h(fp.rawHours)} × {fp.factorPct}% = {h(fp.sellableHours)}</p>
                              ))}
                            </>
                          )}
                          {u.perSite.length > 1 && u.perSite.map((s2: any) => (
                            <p key={s2.siteId}>{s2.siteName}: {h(s2.charged)} ÷ {h(s2.available)} = {pct(s2.ratio)}</p>
                          ))}
                          {!u.configComplete && <p className="text-warn">{t('pnl.utilMissingNames', { names: u.missingHoursMechanics.join(', ') })}</p>}
                        </div>
                      </details>
                    </>
                  )}
              </div>
            );
          }
          if (k === 'hoursCharged') {
            const hrs = d?.hoursChargedCentihours;
            return (
              <div key={k} className={`bg-surface p-5 rounded-xl border border-line ${loading ? 'opacity-60' : ''}`}>
                <h3 className="text-sm font-semibold text-muted mb-2">{t('pnl.hoursCharged')}</h3>
                {hrs != null ? (
                  <>
                    <p className="text-2xl font-bold tabular-nums text-ink">{(hrs / 100).toLocaleString(props.locale, { maximumFractionDigits: 2 })}h</p>
                    <p className="text-xs text-muted mt-1">{t('pnl.hoursChargedSub')}</p>
                    {/* The amber is now a DRILL (same expander pattern as the utilisation tile):
                        distinct products → the product editor (labour_hours set once fixes every
                        line); ad-hoc lines → their invoice. Wording stays distinct from the
                        utilisation tile's mechanics amber (different defect: product editor vs HR). */}
                    {d?.linesMissingHours > 0 && (
                      <details className="mt-1">
                        <summary className="text-xs text-warn cursor-pointer">{t('pnl.hoursMissing', { count: d.linesMissingHours })} →</summary>
                        <div className="text-xs mt-1 space-y-0.5">
                          {((tiles?.missingHours as any)?.products ?? []).map((pr: any) => (
                            <p key={pr.id}>
                              <Link href={`/admin/products?edit=${pr.id}`} className="text-accent underline">{pr.name}</Link>
                              <span className="text-muted"> — {t('pnl.hoursMissingLines', { count: pr.lines })}</span>
                            </p>
                          ))}
                          {((tiles?.missingHours as any)?.adhoc ?? []).map((a: any, i: number) => (
                            <p key={i}>
                              <Link href={`/admin/invoices/${a.invoiceId}`} className="text-accent underline">{a.number}</Link>
                              <span className="text-muted"> — {a.description} ({t('pnl.hoursMissingAdhoc')})</span>
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
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
  const visibleSites = (await prisma.site.findMany({
    where: { id: { in: vis.siteIds } }, orderBy: { created_at: 'asc' }, select: { id: true, site_name: true },
  })) as Array<{ id: string; site_name: string }>;

  return {
    props: {
      groupName: group?.group_name ?? 'Your garage',
      accountRef: group?.ref ?? '—',
      status: group?.status ?? 'trial',
      trialEndsAt: group?.trial_ends_at ? group.trial_ends_at.toISOString() : null,
      sites: visibleSites.map((s2) => ({ id: s2.id, name: s2.site_name })),
      currency: site?.currency_code ?? 'GBP',
      locale: site?.locale ?? 'en-GB',
    },
  };
});
