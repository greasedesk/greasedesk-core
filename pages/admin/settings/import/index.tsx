/**
 * File: pages/admin/settings/import/index.tsx
 * Settings → Invoice Import. Batch list + THE reconciliation panel.
 *
 * Running totals exist so a month can be SEEN to close: parsed vs committed, and the residual
 * stated outright rather than assumed zero.
 */
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';

type Batch = { id: string; label: string; status: string; created_at: string; _count: { invoices: number } };
type Totals = {
  invoices: { total: number; pending: number; inProgress: number; committed: number; skipped: number };
  reconciliation: { reconciled: number; failed: number };
  money: { parsedNetPennies: number; committedNetPennies: number; residualPennies: number };
  vatVariances: number; linesUncosted: number;
};
type Inv = {
  id: string; external_number: string; issue_date: string; registration: string | null;
  subtotal_printed: string; subtotal_parsed: string; reconciled: boolean;
  vat_printed: string | null; vat_computed: string | null;
  status: string; planned_start_at: string | null; _count: { lines: number };
};

const gbp = (p: number) => '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = (s: string) => new Date(s).toISOString().slice(0, 10);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function ImportIndex({ isAdmin, isManager }: { isAdmin: boolean; isManager: boolean }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [invoices, setInvoices] = useState<Inv[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/import/batch').then((r) => r.json()).then((d) => {
      setBatches(d.batches ?? []);
      if (d.batches?.length) setSel(d.batches[0].id);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!sel) return;
    fetch(`/api/import/batch?batchId=${sel}`).then((r) => r.json()).then((d) => {
      setTotals(d.totals ?? null);
      setInvoices(d.invoices ?? []);
    });
  }, [sel]);

  const vatVariance = (i: Inv) =>
    i.vat_printed != null && i.vat_computed != null &&
    Math.abs(Number(i.vat_printed) - Number(i.vat_computed)) >= 0.005;

  return (
    <SettingsLayout isAdmin={isAdmin} isManager={isManager}>
      <Head><title>Invoice Import - GreaseDesk</title></Head>
      <h1 className="text-2xl font-bold text-ink mb-1">Invoice Import</h1>
      <p className="text-sm text-muted mb-6">
        Historical invoices are staged here, then committed one at a time through the app&apos;s own
        write paths. Staging is never the ledger.
      </p>

      {loading && <p className="text-sm text-muted">Loading…</p>}
      {!loading && !batches.length && (
        <div className="bg-surface border border-line rounded-xl p-6 text-sm text-muted">
          No import batches yet.
        </div>
      )}

      {batches.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {batches.map((b) => (
            <button key={b.id} onClick={() => setSel(b.id)}
              className={`text-xs px-3 py-1.5 rounded-full border ${sel === b.id ? 'bg-accent-soft text-accent border-accent' : 'bg-surface text-muted border-line'}`}>
              {b.label} ({b._count.invoices})
            </button>
          ))}
        </div>
      )}

      {/* ── RECONCILIATION PANEL ─────────────────────────────────────────────────────────────── */}
      {totals && (
        <div className="bg-surface border border-line rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-ink mb-3">Reconciliation</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <Stat label="Invoices parsed" value={String(totals.invoices.total)} />
            <Stat label="Committed" value={`${totals.invoices.committed} / ${totals.invoices.total}`} />
            <Stat label="Parsed net" value={gbp(totals.money.parsedNetPennies)} />
            <Stat label="Committed net" value={gbp(totals.money.committedNetPennies)} />
          </div>
          <div className="mt-4 pt-4 border-t border-line grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <Stat label="Residual (still to commit)" value={gbp(totals.money.residualPennies)}
              tone={totals.money.residualPennies === 0 ? 'ok' : 'warn'} />
            <Stat label="Failed reconciliation" value={String(totals.reconciliation.failed)}
              tone={totals.reconciliation.failed ? 'danger' : 'ok'} />
            <Stat label="VAT variances" value={String(totals.vatVariances)}
              tone={totals.vatVariances ? 'warn' : 'ok'} />
            <Stat label="Lines still uncosted" value={String(totals.linesUncosted)}
              tone={totals.linesUncosted ? 'warn' : 'ok'} />
          </div>
          {totals.invoices.skipped > 0 && (
            <p className="text-xs text-muted mt-3">{totals.invoices.skipped} skipped — excluded from the residual by choice.</p>
          )}
        </div>
      )}

      {/* ── INVOICE LIST ─────────────────────────────────────────────────────────────────────── */}
      {invoices.length > 0 && (
        <div className="bg-surface border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-muted text-xs">
              <tr>
                <th className="text-left p-3">Invoice</th>
                <th className="text-left p-3">Date</th>
                <th className="text-left p-3">Reg</th>
                <th className="text-right p-3">Net</th>
                <th className="text-left p-3">Checks</th>
                <th className="text-left p-3">Status</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => {
                const d = new Date(i.issue_date);
                const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
                return (
                  <tr key={i.id} className="border-t border-line">
                    <td className="p-3 font-medium text-ink">{i.external_number}</td>
                    <td className="p-3 text-muted">
                      {ymd(i.issue_date)}{' '}
                      <span className={weekend ? 'text-warn' : 'text-muted'}>{WD[d.getUTCDay()]}</span>
                    </td>
                    <td className="p-3 text-muted">{i.registration ?? '—'}</td>
                    <td className="p-3 text-right text-ink">£{Number(i.subtotal_parsed).toFixed(2)}</td>
                    <td className="p-3">
                      {!i.reconciled && <Chip tone="danger">does not reconcile</Chip>}
                      {vatVariance(i) && <Chip tone="warn">VAT variance</Chip>}
                      {i.reconciled && !vatVariance(i) && <Chip tone="ok">ok</Chip>}
                    </td>
                    <td className="p-3"><Chip tone={i.status === 'committed' ? 'ok' : i.status === 'skipped' ? 'muted' : 'accent'}>{i.status}</Chip></td>
                    <td className="p-3 text-right">
                      <Link href={`/admin/settings/import/${i.id}`} className="text-accent hover:underline text-xs">
                        {i.status === 'committed' ? 'View' : 'Open'} →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SettingsLayout>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }) {
  const c = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-ink';
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold ${c}`}>{value}</div>
    </div>
  );
}
function Chip({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'accent' }) {
  const c = tone === 'ok' ? 'bg-ok-soft text-ok' : tone === 'warn' ? 'bg-warn-soft text-warn'
    : tone === 'danger' ? 'bg-danger-soft text-danger' : tone === 'accent' ? 'bg-accent-soft text-accent'
    : 'bg-surface-muted text-muted';
  return <span className={`inline-block text-xs px-2 py-0.5 rounded-full border border-line mr-1 ${c}`}>{children}</span>;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const g = await requireAdminPage(ctx);
  if (!g.ok) return { redirect: g.redirect };
  return { props: { isAdmin: g.vis.isAdmin, isManager: g.vis.role === 'SITE_MANAGER' } };
};
