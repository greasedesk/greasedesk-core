/**
 * File: pages/admin/invoices/[id].tsx
 * The GreaseDesk invoice — the primary VAT document the customer receives. ONE-OBJECT model: while
 * `issued` this renders the job card's LIVE lines (extra authorised work updates the bill under the
 * same number — edits happen on the card's Quote tab, there is no separate invoice-line editor);
 * once `paid` it renders the frozen snapshot. Warranty (comeback) invoices show a single
 * "no charge" £0 line. Data comes from lib/invoice-doc (shared with the PDF + email, so the three
 * can never disagree). unit_cost is INTERNAL and rendered NOWHERE here. Paid unlock is ADMIN-only
 * and audited. i18n-native, formatMoney, mobile-first.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { useTranslation } from 'next-i18next';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { buildInvoiceDoc } from '@/lib/invoice-doc';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';

type Line = { description: string; qty: number; unitPricePennies: number; vatRate: number; netPennies: number };
type Totals = { breakdown: Array<{ rate: number; netPennies: number; vatPennies: number }>; netPennies: number; vatPennies: number; grossPennies: number };
type PageProps = {
  invoiceId: string;
  number: string;
  status: 'issued' | 'paid';
  series: 'chargeable' | 'warranty';
  issuedAt: string;
  vatRegistered: boolean;
  company: { name: string; vatNumber: string | null; address: string | null };
  customer: { name: string; address: string | null };
  vehicle: { reg: string | null; desc: string | null; vin: string | null; mileage: number | null };
  lines: Line[];
  totals: Totals;
  currency: string;
  locale: string;
  canEdit: boolean;   // issued + manager → edits happen on the card's Quote tab
  isAdmin: boolean;   // paid unlock visibility (server re-checks)
  jobCardId: string;
};

export default function InvoicePage(props: PageProps) {
  const { t } = useTranslation('invoice');
  const router = useRouter();
  const fmt = (p: number) => formatMoney(p, { currency: props.currency, locale: props.locale });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const reg = props.vatRegistered;

  async function emailInvoice() {
    setBusy('email'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: props.invoiceId }) });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? { text: t('emailSent'), ok: true } : { text: data?.message || t('emailError'), ok: false });
    } catch { setMsg({ text: t('emailError'), ok: false }); }
    setBusy(null);
  }

  async function unlock() {
    if (!window.confirm(t('unlockConfirm'))) return;
    setBusy('unlock'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: props.invoiceId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('unlockError'), ok: false }); setBusy(null); return; }
      router.replace(router.asPath); // full state change (paid → issued) — reload the document
    } catch { setMsg({ text: t('unlockError'), ok: false }); setBusy(null); }
  }

  return (
    <>
      <Head><title>{t('title')} {props.number} - GreaseDesk</title></Head>
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <Link href={`/admin/jobcards/${props.jobCardId}`} className="text-sm text-accent hover:underline">← {t('back')}</Link>
          <div className="flex flex-wrap items-center gap-2">
            {props.canEdit && (
              <Link href={`/admin/jobcards/${props.jobCardId}?tab=quote`} className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-4 py-2 hover:bg-surface">{t('editOnCard')}</Link>
            )}
            <a href={`/api/invoice-pdf?id=${props.invoiceId}`} className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-4 py-2 hover:bg-surface">{t('downloadPdf')}</a>
            <button onClick={emailInvoice} disabled={busy !== null} className="text-sm bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 disabled:opacity-50">
              {busy === 'email' ? t('emailSending') : t('emailSend')}
            </button>
            {props.status === 'paid' && props.isAdmin && (
              <button onClick={unlock} disabled={busy !== null} className="text-sm text-danger border border-danger/40 rounded-lg px-4 py-2 hover:bg-danger-soft disabled:opacity-50">
                {busy === 'unlock' ? t('unlocking') : t('unlock')}
              </button>
            )}
          </div>
        </div>

        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}
        {props.status === 'issued' && props.series === 'chargeable' && <p className="text-xs text-muted mb-3">{t('liveNote')}</p>}
        {props.status === 'paid' && <p className="text-xs text-muted mb-3">{t('paidLocked')}</p>}

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
              <div className="flex justify-end gap-1 mt-2">
                {props.series === 'warranty' && (
                  <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-warn-soft text-warn">{t('warrantyBadge')}</span>
                )}
                <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${props.status === 'paid' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>
                  {props.status === 'paid' ? t('paidBadge') : t('issuedBadge')}
                </span>
              </div>
            </div>
          </div>

          {/* Bill-to + vehicle */}
          <div className="flex flex-wrap justify-between gap-4 py-5 border-b border-line">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted mb-1">{t('billTo')}</div>
              <div className="text-sm text-ink font-medium">{props.customer.name}</div>
              {props.customer.address && <div className="text-sm text-muted whitespace-pre-line">{props.customer.address}</div>}
            </div>
            {(props.vehicle.reg || props.vehicle.desc || props.vehicle.vin || props.vehicle.mileage != null) && (
              <div className="text-right">
                <div className="text-xs uppercase tracking-wide text-muted mb-1">{t('vehicle')}</div>
                {props.vehicle.reg && <div className="text-sm text-ink font-medium">{t('vehicleBlock.registration')}: {props.vehicle.reg}</div>}
                {props.vehicle.desc && <div className="text-sm text-muted">{props.vehicle.desc}</div>}
                {props.vehicle.vin && <div className="text-sm text-muted">{t('vehicleBlock.vin')}: {props.vehicle.vin}</div>}
                {props.vehicle.mileage != null && <div className="text-sm text-muted">{t('vehicleBlock.mileage')}: {props.vehicle.mileage.toLocaleString(props.locale)}</div>}
              </div>
            )}
          </div>

          {/* Lines */}
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
                    <td className="py-2 px-2 text-right text-ink tabular-nums">{l.qty}</td>
                    <td className="py-2 px-2 text-right text-ink tabular-nums">{fmt(l.unitPricePennies)}</td>
                    {reg && <td className="py-2 px-2 text-right text-muted tabular-nums">{l.vatRate}%</td>}
                    <td className="py-2 text-right text-ink tabular-nums">{fmt(l.netPennies)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
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

          {!reg && <p className="text-xs text-muted mt-4">{t('notRegistered')}</p>}
        </div>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['invoice'])(async (ctx: any) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };

  const doc = await buildInvoiceDoc(String(ctx.params?.id || ''), user.group_id);
  if (!doc) return { redirect: { destination: '/admin/dashboard', permanent: false } };

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, doc.siteId)) return { redirect: { destination: '/admin/dashboard', permanent: false } };

  return {
    props: {
      invoiceId: doc.invoiceId,
      number: doc.number,
      status: doc.status,
      series: doc.series,
      issuedAt: doc.issuedAt.toLocaleDateString(doc.locale),
      vatRegistered: doc.vatRegistered,
      company: doc.company,
      customer: doc.customer,
      vehicle: doc.vehicle,
      lines: doc.lines.map(({ description, qty, unitPricePennies, vatRate, netPennies }) => ({ description, qty, unitPricePennies, vatRate, netPennies })),
      totals: doc.totals,
      currency: doc.currency,
      locale: doc.locale,
      canEdit: doc.status !== 'paid' && doc.series === 'chargeable',
      isAdmin: vis.isAdmin,
      jobCardId: doc.jobCardId,
    },
  };
});
