/**
 * File: pages/admin/invoices/import/index.tsx
 * Settings → Invoice Import. Batch list + THE reconciliation panel.
 *
 * Running totals exist so a month can be SEEN to close: parsed vs committed, and the residual
 * stated outright rather than assumed zero.
 */
import React, { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireImportPage, importableSiteIds } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';

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
const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const ymd = (s: string) => new Date(s).toISOString().slice(0, 10);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One file's outcome, kept AFTER the run: "3 files could not be read" is useless without which. */
type UploadOutcome = { file: string; ok: boolean; reconciled?: boolean; reason?: string };

export default function ImportIndex({ isAdmin, isManager, sites }: { isAdmin: boolean; isManager: boolean; sites: Array<{ id: string; name: string }> }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [invoices, setInvoices] = useState<Inv[]>([]);
  const [loading, setLoading] = useState(true);
  // ── upload state ──────────────────────────────────────────────────────────────────────────
  const [label, setLabel] = useState('');
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [phase, setPhase] = useState<null | 'extracting' | 'ingesting'>(null);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [outcomes, setOutcomes] = useState<UploadOutcome[]>([]); // PERSISTS after the run
  const [uploadMsg, setUploadMsg] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /**
   * TWO PHASES, because they cost wildly different amounts of time: extraction is ~2ms a file and
   * the upload is not. One bar would sit at 100% while the network ran.
   *
   * Batched at 10 invoices a request rather than one 12MB body — the API's limit is against TEXT,
   * and batching is what makes per-file progress meaningful anyway.
   *
   * UNREADABLE IS A SKIP: extraction throws, the file never reaches staging, and it is named in the
   * summary. UNBALANCED IS STAGED and refused at commit. Those are different states; this keeps
   * them different.
   */
  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    if (!label.trim()) { setUploadMsg({ text: 'Give the batch a name first, e.g. "May 2026".', tone: 'err' }); return; }
    if (!siteId) { setUploadMsg({ text: 'Choose the location these invoices belong to.', tone: 'err' }); return; }
    const list = Array.from(files);
    setOutcomes([]); setUploadMsg(null); setTotal(list.length); setDone(0); setPhase('extracting');

    const { extractLayoutText } = await import('@/lib/pdf-layout');
    const extracted: Array<{ filename: string; text: string }> = [];
    const failures: UploadOutcome[] = [];
    for (const f of list) {
      try {
        const text = await extractLayoutText(f);
        extracted.push({ filename: f.name, text });
      } catch (e: any) {
        // Not a PDF, encrypted, or corrupt. Skipped — and NAMED, so it can be chased.
        failures.push({ file: f.name, ok: false, reason: e?.message?.slice(0, 120) || 'could not be read' });
      }
      setDone((n) => n + 1);
    }

    setPhase('ingesting'); setDone(0); setTotal(extracted.length);
    const results: UploadOutcome[] = [...failures];
    let batchId: string | null = sel;
    const CHUNK = 10;
    try {
      for (let i = 0; i < extracted.length; i += CHUNK) {
        const slice = extracted.slice(i, i + CHUNK);
        const r = await fetch('/api/import/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label.trim(), siteId, invoices: slice, ...(batchId ? { batchId } : {}) }),
        });
        const text = await r.text();
        let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* non-JSON error */ }
        if (!r.ok) {
          setUploadMsg({ text: j?.message ?? `Upload failed: ${text.slice(0, 120)}`, tone: 'err' });
          break;
        }
        batchId = j.batchId ?? batchId; // every later chunk tops up the SAME batch
        for (const res of j.results ?? []) results.push({ file: res.file, ok: res.ok, reconciled: res.reconciled, reason: res.reason });
        setDone((n) => n + slice.length);
      }
    } catch (e: any) {
      setUploadMsg({ text: `Upload did not complete: ${e?.message ?? 'no response'}.`, tone: 'err' });
    }

    setOutcomes(results);
    setPhase(null);
    if (fileRef.current) fileRef.current.value = '';
    const staged = results.filter((r) => r.ok).length;
    const bad = results.length - staged;
    if (!uploadMsg) setUploadMsg({ text: `${staged} invoice${staged === 1 ? '' : 's'} staged${bad ? `, ${bad} not read` : ''}.`, tone: bad ? 'err' : 'ok' });
    // Refresh the batch list and the selected batch's contents.
    const bs = await (await fetch('/api/import/batch')).json();
    setBatches(bs.batches ?? []);
    if (batchId) setSel(batchId);
  }

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

      {/* ── UPLOAD ─────────────────────────────────────────────────────────────────────────── */}
      <div className="bg-surface border border-line rounded-xl p-4 mb-6">
        <h2 className="text-sm font-semibold text-ink mb-2">Add invoices</h2>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <div>
            <label className="block text-xs text-muted mb-1">Batch name</label>
            <input className={inputCls} placeholder="e.g. May 2026" value={label}
              onChange={(e) => setLabel(e.target.value)} disabled={!!phase} />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Location</label>
            <select className={inputCls} value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={!!phase}>
              {sites.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </select>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple disabled={!!phase}
          onChange={(e) => onFiles(e.target.files)}
          className="block w-full text-sm text-muted file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:bg-accent file:text-white hover:file:bg-accent-hover disabled:opacity-50" />
        <p className="text-xs text-muted mt-2">
          Select the month&apos;s PDFs — all of them at once. They are read <strong>in this browser</strong>;
          only the extracted text is uploaded, and nothing reaches the ledger until you commit each invoice.
        </p>

        {/* TWO-PHASE progress: extraction is instant, the upload is not. */}
        {phase && (
          <div className="mt-3">
            <div className="flex justify-between text-xs text-muted mb-1">
              <span>{phase === 'extracting' ? `Reading PDFs — ${done}/${total}` : `Uploading — ${done}/${total}`}</span>
              <span>{total ? Math.round((done / total) * 100) : 0}%</span>
            </div>
            <div className="h-2 bg-surface-muted rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {uploadMsg && (
          <p className={`text-xs mt-2 ${uploadMsg.tone === 'ok' ? 'text-ok' : 'text-danger'}`}>{uploadMsg.text}</p>
        )}

        {/* THE FAILURE SUMMARY PERSISTS, and names names. */}
        {outcomes.some((o) => !o.ok) && (
          <div className="mt-3 text-xs bg-danger-soft border border-danger rounded-lg p-2">
            <p className="text-danger font-medium mb-1">
              {outcomes.filter((o) => !o.ok).length} file(s) could not be read — nothing was staged for these:
            </p>
            <ul className="space-y-0.5">
              {outcomes.filter((o) => !o.ok).map((o) => (
                <li key={o.file} className="text-ink">{o.file} <span className="text-muted">— {o.reason}</span></li>
              ))}
            </ul>
            <p className="text-muted mt-1">
              Check they are invoice PDFs rather than scans or statements, then add them again — this tops up the
              same batch rather than starting a new one.
            </p>
          </div>
        )}
        {outcomes.some((o) => o.ok && o.reconciled === false) && (
          <p className="text-xs text-warn mt-2">
            {outcomes.filter((o) => o.ok && o.reconciled === false).length} staged invoice(s) do not reconcile against
            their own printed subtotal. They are in the batch and flagged; commit will refuse them until they balance.
          </p>
        )}
      </div>

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
                      <Link href={`/admin/invoices/import/${i.id}`} className="text-accent hover:underline text-xs">
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
  const g = await requireImportPage(ctx);
  if (!g.ok) return { redirect: g.redirect };
  // Only the sites this caller may import INTO — the same set the API enforces, so the picker can
  // never offer a location the batch endpoint would refuse.
  const ids = importableSiteIds(g.vis);
  const rows = await prisma.site.findMany({ where: { id: { in: ids } }, select: { id: true, site_name: true }, orderBy: { site_name: 'asc' } });
  return {
    props: {
      isAdmin: g.vis.isAdmin, isManager: g.vis.role === 'SITE_MANAGER',
      sites: rows.map((r: any) => ({ id: r.id, name: r.site_name })),
    },
  };
};
