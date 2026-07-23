/**
 * File: pages/admin/reports/vat.tsx
 * VAT on sales — the accountant's reconciliation summary. OUTPUT VAT ONLY, labelled unambiguously so it
 * can never read as a complete VAT return. ADMIN-only. Period presets (quarters/FYs) + custom range;
 * exports to PDF + CSV. Input/purchase VAT is deliberately absent (no purchase-recording module yet).
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminPage } from '@/lib/admin-guard';
import { resolveRange } from '@/lib/dashboard-periods';
import { getVatSummary, type VatSummary } from '@/lib/vat-summary';
import { formatMoney, currencySymbol } from '@/lib/format-money';

type PageProps = {
  summary: VatSummary; periodLabel: string; preset: string; from: string; to: string;
  currency: string; locale: string; vatRegistered: boolean; groupName: string;
};

const PRESETS: Array<{ key: string; label: string }> = [
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'last_quarter', label: 'Last quarter' },
  { key: 'this_fy', label: 'This financial year' },
  { key: 'last_fy', label: 'Last financial year' },
  { key: 'custom', label: 'Custom range…' },
];

export default function VatReport(props: PageProps) {
  const { summary, periodLabel, currency, locale, vatRegistered, groupName } = props;
  const router = useRouter();
  const [preset, setPreset] = useState(props.preset || 'this_quarter');
  const [from, setFrom] = useState(props.from || '');
  const [to, setTo] = useState(props.to || '');
  const fmt = (p: number) => formatMoney(p, { currency, locale });

  function apply(nextPreset: string, f = from, tt = to) {
    setPreset(nextPreset);
    const q = nextPreset === 'custom' ? (f && tt ? { from: f, to: tt } : null) : { preset: nextPreset };
    if (!q) return; // custom needs both dates
    router.push({ pathname: '/admin/reports/vat', query: q });
  }
  const qs = preset === 'custom' ? `from=${from}&to=${to}` : `preset=${preset}`;

  return (
    <>
      <Head><title>VAT on sales - GreaseDesk</title></Head>
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-ink mb-1">VAT on sales</h1>
        <p className="text-muted mb-4">{groupName} · {periodLabel}</p>

        {/* The unambiguous label — this is a reconciliation aid, never a complete return. */}
        <div className="bg-warn-soft border border-warn text-warn rounded-xl p-4 mb-5 text-sm">
          <span className="font-semibold">VAT on sales for the period — provide to your accountant for your return.</span>{' '}
          This shows <span className="font-medium">output VAT on your issued sales invoices only</span> and
          <span className="font-medium"> excludes purchase / input VAT</span> (parts, overheads and other purchases).
          It is not a complete VAT return.
        </div>

        {!vatRegistered && (
          <div className="bg-surface-muted border border-line rounded-lg p-3 mb-4 text-sm text-muted">
            Your account is set to <span className="font-medium">not VAT-registered</span>, so output VAT is {currencySymbol({ currency, locale })}0. Change this in Settings if you are registered.
          </div>
        )}

        {/* Period selector */}
        <div className="flex flex-wrap items-center gap-2 mb-5">
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => apply(p.key)}
              className={`text-sm rounded-lg px-3 py-1.5 border ${preset === p.key ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink hover:bg-surface-muted'}`}>
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <span className="flex items-center gap-2">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
              <span className="text-muted text-sm">→</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
              <button onClick={() => apply('custom', from, to)} disabled={!from || !to} className="text-sm rounded-lg px-3 py-1.5 bg-accent text-white disabled:opacity-50">Apply</button>
            </span>
          )}
        </div>

        {/* Figures */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-surface border border-line rounded-xl p-5">
            <div className="text-xs uppercase tracking-wide text-muted mb-1">Total sales (ex-VAT)</div>
            <div className="text-2xl font-bold text-ink tabular-nums">{fmt(summary.netPennies)}</div>
          </div>
          <div className="bg-surface border border-accent rounded-xl p-5">
            <div className="text-xs uppercase tracking-wide text-muted mb-1">Total output VAT</div>
            <div className="text-2xl font-bold text-ink tabular-nums">{fmt(summary.vatPennies)}</div>
          </div>
          <div className="bg-surface border border-line rounded-xl p-5">
            <div className="text-xs uppercase tracking-wide text-muted mb-1">Invoices</div>
            <div className="text-2xl font-bold text-ink tabular-nums">{summary.invoiceCount}</div>
          </div>
        </div>

        {/* Rate breakdown */}
        <div className="bg-surface border border-line rounded-xl overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-muted">
              <tr className="text-left"><th className="px-4 py-2 font-medium">VAT rate</th><th className="px-4 py-2 font-medium text-right">Net (ex-VAT)</th><th className="px-4 py-2 font-medium text-right">VAT</th><th className="px-4 py-2 font-medium text-right">Lines</th></tr>
            </thead>
            <tbody>
              {summary.byRate.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">No sales invoices in this period.</td></tr>}
              {summary.byRate.map((r) => (
                <tr key={r.ratePercent} className="border-t border-line">
                  <td className="px-4 py-2 text-ink">{r.ratePercent}%</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(r.netPennies)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(r.vatPennies)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.lineCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Exports */}
        <div className="flex flex-wrap gap-3">
          <a href={`/api/reports/vat-summary-pdf?${qs}`} target="_blank" rel="noreferrer" className="bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 text-sm font-medium">Download PDF</a>
          <a href={`/api/reports/vat-summary?format=csv&${qs}`} className="bg-surface border border-line text-ink rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-surface-muted">Download CSV</a>
        </div>
        <p className="text-xs text-muted mt-4">Figures come from the same issued-invoice ledger as your Invoices list, by invoice date. Input/purchase VAT recording is a future step.</p>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;
  const groupId = vis.groupId as string;

  const group = (await prisma.group.findUnique({ where: { id: groupId }, select: { fy_start_month: true, vat_registered: true, group_name: true } })) as { fy_start_month: number; vat_registered: boolean; group_name: string } | null;
  const site = vis.primarySiteId
    ? ((await prisma.site.findUnique({ where: { id: vis.primarySiteId }, select: { currency_code: true, locale: true } })) as { currency_code: string; locale: string } | null)
    : null;

  const q = { preset: ctx.query.preset as string, from: ctx.query.from as string, to: ctx.query.to as string };
  const range = resolveRange(q.preset || q.from ? q : { preset: 'this_quarter' }, group?.fy_start_month ?? 4) ?? resolveRange({ preset: 'this_quarter' }, group?.fy_start_month ?? 4)!;
  const summary = await getVatSummary(groupId, vis.siteIds, range.from, range.to);
  const inclusiveEnd = new Date(range.to.getTime() - 1).toISOString().slice(0, 10);
  const periodLabel = `${summary.fromISO.slice(0, 10)} to ${inclusiveEnd}`;

  return {
    props: {
      summary, periodLabel,
      preset: (q.preset || (q.from ? 'custom' : 'this_quarter')),
      from: q.from ?? '', to: q.to ?? '',
      currency: site?.currency_code ?? 'GBP', locale: site?.locale ?? 'en-GB',
      vatRegistered: group?.vat_registered ?? true, groupName: group?.group_name ?? 'Your business',
    },
  };
};
