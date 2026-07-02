/**
 * File: pages/admin/invoices/[id].tsx
 * The GreaseDesk invoice — the primary VAT document the customer receives. Complete legal header
 * (company identity + VAT number from the ISSUE snapshot), customer + vehicle, lines, and a correct
 * multi-rate VAT breakdown. unit_cost is INTERNAL and rendered NOWHERE here. Editable until paid
 * (manual line corrections + parts roll-up) via /api/invoice; frozen once paid. i18n-native,
 * formatMoney, mobile-first, and deliberately clean so the next slice can render it to PDF.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { useTranslation } from 'next-i18next';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { canEditInvoice, invoiceTotals } from '@/lib/invoice';
import { poundsToPennies, penniesToPounds } from '@/lib/quote-totals';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';

type Line = { description: string; qtyStr: string; unitPriceStr: string; vatRateStr: string; netPennies: number; vatPennies: number; grossPennies: number };
type Totals = { breakdown: Array<{ rate: number; netPennies: number; vatPennies: number }>; netPennies: number; vatPennies: number; grossPennies: number };
type PageProps = {
  invoiceId: string;
  number: string;
  status: 'issued' | 'paid';
  issuedAt: string;
  vatRegistered: boolean;
  company: { name: string; vatNumber: string | null; address: string | null };
  customer: { name: string; address: string | null };
  vehicle: { reg: string | null; desc: string | null };
  lines: Line[];
  totals: Totals;
  currency: string;
  locale: string;
  canEdit: boolean;
  jobCardId: string;
};

const money = (p: number, currency: string, locale: string) => formatMoney(p, { currency, locale });

export default function InvoicePage(props: PageProps) {
  const { t } = useTranslation('invoice');
  const router = useRouter();
  const fmt = (p: number) => money(p, props.currency, props.locale);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Line[]>(props.lines);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const reg = props.vatRegistered;

  const setRow = (i: number, patch: Partial<Line>) => setRows((p) => p.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((p) => [...p, { description: '', qtyStr: '1', unitPriceStr: '0', vatRateStr: '0', netPennies: 0, vatPennies: 0, grossPennies: 0 }]);
  const removeRow = (i: number) => setRows((p) => p.filter((_, j) => j !== i));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/invoice', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoiceId: props.invoiceId,
          lines: rows.map((r) => ({ description: r.description, qty: r.qtyStr, unitPrice: r.unitPriceStr, vatRate: r.vatRateStr })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); setBusy(false); return; }
      setMsg({ text: t('saved'), ok: true }); setEditing(false);
      router.replace(router.asPath);
    } catch { setMsg({ text: t('error'), ok: false }); }
    setBusy(false);
  }

  return (
    <>
      <Head><title>{t('title')} {props.number} - GreaseDesk</title></Head>
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <Link href={`/admin/jobcards/${props.jobCardId}`} className="text-sm text-accent hover:underline">← {t('back')}</Link>
          {props.canEdit && !editing && (
            <button onClick={() => setEditing(true)} className="text-sm bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2">{t('edit')}</button>
          )}
        </div>

        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}
        {!props.canEdit && props.status === 'paid' && <p className="text-xs text-muted mb-3">{t('paidLocked')}</p>}

        {/* The document */}
        <div className="bg-surface border border-line rounded-xl p-5 sm:p-8">
          {/* Header */}
          <div className="flex flex-wrap justify-between gap-4 pb-5 border-b border-line">
            <div className="min-w-0">
              <div className="text-lg font-bold text-ink">{props.company.name}</div>
              {props.company.address && <div className="text-sm text-muted whitespace-pre-line">{props.company.address}</div>}
              {reg && props.company.vatNumber && (
                <div className="text-xs text-muted mt-1">{t('vatNumber')} {props.company.vatNumber}</div>
              )}
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-ink tracking-wide">{t('title').toUpperCase()}</div>
              <div className="text-sm text-ink font-mono mt-1">{props.number}</div>
              <div className="text-xs text-muted">{t('issued')}: {props.issuedAt}</div>
              <span className={`inline-block mt-2 text-[10px] font-semibold px-2 py-0.5 rounded-full ${props.status === 'paid' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>
                {props.status === 'paid' ? t('paidBadge') : t('issuedBadge')}
              </span>
            </div>
          </div>

          {/* Bill-to + vehicle */}
          <div className="flex flex-wrap justify-between gap-4 py-5 border-b border-line">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted mb-1">{t('billTo')}</div>
              <div className="text-sm text-ink font-medium">{props.customer.name}</div>
              {props.customer.address && <div className="text-sm text-muted whitespace-pre-line">{props.customer.address}</div>}
            </div>
            {(props.vehicle.reg || props.vehicle.desc) && (
              <div className="text-right">
                <div className="text-xs uppercase tracking-wide text-muted mb-1">{t('vehicle')}</div>
                {props.vehicle.reg && <div className="text-sm text-ink font-medium">{props.vehicle.reg}</div>}
                {props.vehicle.desc && <div className="text-sm text-muted">{props.vehicle.desc}</div>}
              </div>
            )}
          </div>

          {/* Lines */}
          {editing ? (
            <div className="py-5 space-y-2">
              <p className="text-xs text-muted">{t('rollupHint')}</p>
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <textarea value={r.description} rows={2} onChange={(e) => setRow(i, { description: e.target.value })} placeholder={t('cols.description')}
                    className="col-span-12 sm:col-span-5 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink resize-y" />
                  <input type="number" inputMode="decimal" step="0.01" value={r.qtyStr} onChange={(e) => setRow(i, { qtyStr: e.target.value })} aria-label={t('cols.qty')}
                    className="col-span-3 sm:col-span-2 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink text-right" />
                  <input type="number" inputMode="decimal" step="0.01" value={r.unitPriceStr} onChange={(e) => setRow(i, { unitPriceStr: e.target.value })} aria-label={t('cols.unitPrice')}
                    className="col-span-4 sm:col-span-2 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink text-right" />
                  {reg ? (
                    <input type="number" inputMode="decimal" step="0.01" min={0} max={100} value={r.vatRateStr} onChange={(e) => setRow(i, { vatRateStr: e.target.value })} aria-label={t('cols.vatRate')}
                      className="col-span-3 sm:col-span-2 bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink text-right" />
                  ) : <span className="hidden sm:block sm:col-span-2" />}
                  <button onClick={() => removeRow(i)} className="col-span-2 sm:col-span-1 text-xs text-danger hover:underline">{t('remove')}</button>
                </div>
              ))}
              <button onClick={addRow} className="text-sm text-accent hover:underline">+ {t('addLine')}</button>
              <div className="flex items-center gap-2 pt-3">
                <button onClick={save} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? t('saving') : t('save')}</button>
                <button onClick={() => { setEditing(false); setRows(props.lines); }} className="text-muted hover:text-ink rounded-lg px-4 py-2 text-sm">{t('cancel')}</button>
              </div>
            </div>
          ) : (
            <div className="py-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted text-xs uppercase tracking-wide border-b border-line">
                    <th className="text-left font-medium py-2">{t('cols.description')}</th>
                    <th className="text-right font-medium py-2 px-2">{t('cols.qty')}</th>
                    <th className="text-right font-medium py-2 px-2">{t('cols.unitPrice')}</th>
                    {reg && <th className="text-right font-medium py-2 px-2">{t('cols.vatRate')}</th>}
                    <th className="text-right font-medium py-2">{reg ? t('cols.net') : t('cols.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {props.lines.map((l, i) => (
                    <tr key={i} className="border-b border-line/60">
                      <td className="py-2 text-ink whitespace-pre-line">{l.description}</td>
                      <td className="py-2 px-2 text-right text-ink tabular-nums">{l.qtyStr}</td>
                      <td className="py-2 px-2 text-right text-ink tabular-nums">{fmt(poundsToPenniesClient(l.unitPriceStr))}</td>
                      {reg && <td className="py-2 px-2 text-right text-muted tabular-nums">{l.vatRateStr}%</td>}
                      <td className="py-2 text-right text-ink tabular-nums">{fmt(l.netPennies)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Totals */}
          {!editing && (
            <div className="pt-4 border-t border-line flex justify-end">
              <div className="w-full sm:w-72 text-sm space-y-1">
                {reg ? (
                  <>
                    <div className="flex justify-between"><span className="text-muted">{t('subtotal')}</span><span className="text-ink tabular-nums">{fmt(props.totals.netPennies)}</span></div>
                    {props.totals.breakdown.map((b) => (
                      <div key={b.rate} className="flex justify-between"><span className="text-muted">{t('vatAt', { rate: b.rate })}</span><span className="text-ink tabular-nums">{fmt(b.vatPennies)}</span></div>
                    ))}
                    <div className="flex justify-between"><span className="text-muted">{t('totalVat')}</span><span className="text-ink tabular-nums">{fmt(props.totals.vatPennies)}</span></div>
                    <div className="flex justify-between text-base font-semibold border-t border-line pt-1"><span className="text-ink">{t('grandTotal')}</span><span className="text-ink tabular-nums">{fmt(props.totals.grossPennies)}</span></div>
                  </>
                ) : (
                  <div className="flex justify-between text-base font-semibold"><span className="text-ink">{t('total')}</span><span className="text-ink tabular-nums">{fmt(props.totals.netPennies)}</span></div>
                )}
              </div>
            </div>
          )}

          {!reg && <p className="text-xs text-muted mt-4">{t('notRegistered')}</p>}
        </div>
      </div>
    </>
  );
}

// Client-side pounds→pennies for rendering a stored unit price (kept tiny; the server owns the maths).
function poundsToPenniesClient(s: string): number {
  return Math.round((Number(s) || 0) * 100);
}

export const getServerSideProps = withI18n(['invoice'])(async (ctx: any) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };

  const inv = (await prisma.invoice.findFirst({
    where: { id: String(ctx.params?.id || ''), group_id: user.group_id },
    select: {
      id: true, site_id: true, status: true, invoice_number: true, issued_at: true, job_card_id: true,
      company_name_snapshot: true, company_vat_number_snapshot: true, company_address_snapshot: true,
      customer_name_snapshot: true, customer_address_snapshot: true,
      vehicle_reg_snapshot: true, vehicle_desc_snapshot: true, vat_registered_at_issue: true,
      lines: { orderBy: { position: 'asc' }, select: { description: true, qty: true, unit_price: true, vat_rate: true, line_vat: true, line_total: true } },
      site: { select: { currency_code: true, locale: true } },
    },
  })) as any;
  if (!inv) return { redirect: { destination: '/admin/dashboard', permanent: false } };

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, inv.site_id)) return { redirect: { destination: '/admin/dashboard', permanent: false } };

  const totals = invoiceTotals(inv.lines);
  const lines: Line[] = inv.lines.map((l: any) => {
    const netP = poundsToPennies(Number(l.line_total));
    const vatP = poundsToPennies(Number(l.line_vat));
    return {
      description: l.description,
      qtyStr: Number(l.qty).toString(),
      unitPriceStr: Number(l.unit_price).toFixed(2),
      vatRateStr: Number(l.vat_rate).toString(),
      netPennies: netP, vatPennies: vatP, grossPennies: netP + vatP,
    };
  });

  return {
    props: {
      invoiceId: inv.id,
      number: inv.invoice_number ?? '',
      status: inv.status,
      issuedAt: new Date(inv.issued_at).toLocaleDateString('en-GB'),
      vatRegistered: !!inv.vat_registered_at_issue,
      company: { name: inv.company_name_snapshot, vatNumber: inv.company_vat_number_snapshot, address: inv.company_address_snapshot },
      customer: { name: inv.customer_name_snapshot, address: inv.customer_address_snapshot },
      vehicle: { reg: inv.vehicle_reg_snapshot, desc: inv.vehicle_desc_snapshot },
      lines,
      totals,
      currency: inv.site?.currency_code ?? 'GBP',
      locale: inv.site?.locale ?? 'en-GB',
      canEdit: canEditInvoice(inv) && canManageSite(vis, inv.site_id),
      jobCardId: inv.job_card_id,
    },
  };
});
