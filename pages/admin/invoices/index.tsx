/**
 * File: pages/admin/invoices/index.tsx
 * The Invoices view — accounts-receivable/debtors surface. Permission-gated server-side in gssp
 * (canViewInvoices: managers/admins always, STANDARD via the tenant toggle) AND on the list API;
 * rows are site-scoped server-side (vis.siteIds). Status filter (all/unpaid/pending/paid/warranty
 * — "unpaid" is the debtors view) + customer/reg search. Actions: View (the existing invoice
 * page), PDF (existing route), Re-send (the ONE existing send path, confirmed with number +
 * recipient first — accidental re-sends annoy customers). Amounts are gross (what's owed) and
 * visible to anyone holding the permission — an AR view with hidden amounts is useless.
 * Status treatments reuse the paid-pending build's: amber pending is NEVER the green PAID face.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { useTranslation } from 'next-i18next';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canViewInvoices } from '@/lib/permissions';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';

type Row = {
  id: string; number: string; customer: string; reg: string | null;
  status: 'issued' | 'paid_pending' | 'paid' | 'settled'; series: 'chargeable' | 'warranty';
  issuedAt: string; receiptSent: boolean; manualPending?: boolean; method?: string | null; grossPennies: number; currency: string; locale: string;
  jobCardId: string; recipientEmail: string | null;
};
const FILTERS = ['all', 'unpaid', 'pending', 'paid', 'warranty'] as const;
// 'issued' is an ARRIVAL-ONLY filter (dashboard "Issued vs paid" tile): chargeable issued-in-period,
// any status. It has no tab — the period banner names it; picking any tab replaces it.
type Filter = typeof FILTERS[number] | 'issued';
type PeriodQS = { preset?: string; from?: string; to?: string } | null;
const periodToQS = (pd: PeriodQS) => (pd ? (pd.preset ? `&preset=${pd.preset}` : `&from=${pd.from}&to=${pd.to}`) : '');

function StatusChip({ row, t }: { row: Row; t: (k: string) => string }) {
  // Warranty settles at issue (terminal, £0, never AR) — the chip says CLOSED, not outstanding.
  if (row.series === 'warranty') return <span className="text-xs font-semibold rounded-full px-2.5 py-1 bg-accent-soft text-accent">{row.status === 'settled' ? t('chip.settled') : t('chip.warranty')}</span>;
  if (row.status === 'paid') return <span className="text-xs font-semibold rounded-full px-2.5 py-1 bg-ok-soft text-ok">{t('chip.paid')}</span>;
  if (row.status === 'paid_pending') return <span className="text-xs font-semibold rounded-full px-2.5 py-1 bg-warn-soft text-warn">{row.manualPending ? t('chip.pendingManual') : t('chip.pending')}</span>;
  return <span className="text-xs font-semibold rounded-full px-2.5 py-1 bg-surface-muted text-ink border border-line">{t('chip.unpaid')}</span>;
}

export default function InvoicesPage() {
  const { t } = useTranslation('invoices');
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [period, setPeriod] = useState<PeriodQS>(null);            // active period (from a tile)
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null); // server-resolved echo
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(f: Filter, query: string, pd: PeriodQS) {
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices?status=${f}&q=${encodeURIComponent(query)}${periodToQS(pd)}`, { cache: 'no-store' });
      if (res.ok) { const d = await res.json(); setRows(d.invoices || []); setApplied(d.period ?? null); }
    } catch { /* list stays; friendly enough */ }
    setLoading(false);
  }
  // Initial load honours tile-passed URL params (status + preset|from/to); bare arrival = as before.
  useEffect(() => {
    if (!router.isReady) return;
    const qs = router.query;
    const st = String(qs.status || 'all');
    const f: Filter = (FILTERS as readonly string[]).includes(st) || st === 'issued' ? (st as Filter) : 'all';
    const pd: PeriodQS = qs.preset ? { preset: String(qs.preset) } : (qs.from && qs.to ? { from: String(qs.from), to: String(qs.to) } : null);
    setFilter(f); setPeriod(pd);
    load(f, '', pd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);
  const setFilterAndLoad = (f: Filter) => { setFilter(f); load(f, q, period); };
  const clearPeriod = () => {
    const f: Filter = filter === 'issued' ? 'all' : filter; // 'issued' only means anything WITH a period
    setPeriod(null); setApplied(null); setFilter(f);
    router.replace('/admin/invoices', undefined, { shallow: true });
    load(f, q, null);
  };
  const onSearch = (v: string) => {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(filter, v, period), 350);
  };

  async function resend(r: Row) {
    if (!r.recipientEmail) { setMsg({ text: t('resend.noEmail'), ok: false }); return; }
    if (!window.confirm(t('resend.confirm', { number: r.number, email: r.recipientEmail }))) return;
    setBusy(r.id); setMsg(null);
    try {
      const res = await fetch('/api/invoice-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: r.id }) });
      const d = await res.json().catch(() => ({}));
      setMsg(res.ok ? { text: t('resend.sent', { number: r.number }), ok: true } : { text: d?.message || t('resend.error'), ok: false });
    } catch { setMsg({ text: t('resend.error'), ok: false }); }
    setBusy(null);
  }

  const totalShown = useMemo(() => rows.reduce((a, r) => a + r.grossPennies, 0), [rows]);
  const cur = rows[0];

  return (
    <>
      <Head><title>{t('title')} - GreaseDesk</title></Head>
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h1 className="text-xl font-bold text-ink">{t('title')}</h1>
          {cur && <span className="text-sm text-muted">{t('totalShown')}: <span className="text-ink font-semibold tabular-nums">{formatMoney(totalShown, { currency: cur.currency, locale: cur.locale })}</span></span>}
        </div>

        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => setFilterAndLoad(f)}
                className={`shrink-0 text-sm rounded-lg px-3 py-2 border ${filter === f ? 'bg-accent text-white border-accent font-semibold' : 'bg-surface text-ink border-line hover:bg-surface-muted'}`}>
                {t(`filter.${f}`)}
              </button>
            ))}
          </div>
          <input value={q} onChange={(e) => onSearch(e.target.value)} placeholder={t('searchPh')}
            className="sm:ml-auto sm:w-64 p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm focus:ring-accent focus:border-accent" />
        </div>

        {applied && (
          <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg mb-3 text-sm bg-accent-soft text-accent">
            <span>
              {t('periodBanner', {
                label: t(`filter.${filter}`),
                from: new Date(applied.from).toLocaleDateString(cur?.locale ?? 'en-GB'),
                to: new Date(new Date(applied.to).getTime() - 86400000).toLocaleDateString(cur?.locale ?? 'en-GB'),
              })}
            </span>
            <button onClick={clearPeriod} className="underline font-semibold">{t('periodClear')}</button>
          </div>
        )}
        {msg && <div className={`p-2 rounded-lg mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        <div className="bg-surface border border-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-xs uppercase tracking-wide border-b border-line">
                <th className="text-left font-medium p-3">{t('col.number')}</th>
                <th className="text-left font-medium p-3">{t('col.customer')}</th>
                <th className="text-left font-medium p-3">{t('col.reg')}</th>
                <th className="text-right font-medium p-3">{t('col.amount')}</th>
                <th className="text-left font-medium p-3">{t('col.date')}</th>
                <th className="text-left font-medium p-3">{t('col.status')}</th>
                <th className="text-right font-medium p-3">{t('col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="p-6 text-center text-muted">{t('loading')}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="p-6 text-center text-muted">{t('empty')}</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 hover:bg-surface-muted/50">
                  <td className="p-3 font-mono text-ink whitespace-nowrap">{r.number}</td>
                  <td className="p-3 text-ink">{r.customer || '—'}</td>
                  <td className="p-3 text-ink whitespace-nowrap">{r.reg || '—'}</td>
                  <td className="p-3 text-right text-ink tabular-nums whitespace-nowrap">{formatMoney(r.grossPennies, { currency: r.currency, locale: r.locale })}</td>
                  <td className="p-3 text-muted whitespace-nowrap">{new Date(r.issuedAt).toLocaleDateString(r.locale)}</td>
                  <td className="p-3"><StatusChip row={r} t={t} /></td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <Link href={`/admin/invoices/${r.id}`} className="text-accent hover:underline text-sm">{t('action.view')}</Link>
                    <Link href={`/admin/jobcards/${r.jobCardId}`} className="text-accent hover:underline text-sm ml-3">{t('action.jobCard')}</Link>
                    <a href={`/api/invoice-pdf?id=${r.id}`} className="text-accent hover:underline text-sm ml-3">{t('action.pdf')}</a>
                    <button onClick={() => resend(r)} disabled={busy !== null} className="text-accent hover:underline text-sm ml-3 disabled:opacity-50">
                      {busy === r.id ? t('action.sending') : t('action.resend')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted mt-3">{t('footnote')}</p>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = withI18n(['invoices'])(async (ctx: any) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  // Server-side permission gate — the menu item's visibility is decoration, THIS is the control
  // (the list API 403s independently).
  const vis = await getVisibility(user.id as string);
  const perms = await getTenantPermissions(user.group_id as string);
  if (!canViewInvoices(vis, perms)) return { redirect: { destination: '/admin/dashboard', permanent: false } };
  return { props: {} };
});
