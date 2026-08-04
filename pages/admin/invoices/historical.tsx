/**
 * File: pages/admin/invoices/historical.tsx
 * Record an invoice issued under a PREVIOUS system. Admin only, ONE PDF per pass, deliberately.
 *
 * ── WHY ONE AT A TIME ───────────────────────────────────────────────────────────────────────────
 * The document supplies about two thirds of what a useful record needs. Labour hours, parts cost
 * and payment method are not on it and have to be recalled per invoice. A bulk importer would
 * make skipping them the path of least resistance, and labour hours are the utilisation
 * denominator — the field most costly to skip and least visible when missing.
 *
 * ── EXTRACTION RUNS IN THE BROWSER ──────────────────────────────────────────────────────────────
 * pdfjs-dist, because Poppler (pdftotext) is not available on Vercel. The browser produces a text
 * layer that reproduces the LAYOUT — column positions matter to the parser — and posts it; the
 * SERVER parses it with the same parser proven 42/42 against the May set, and stores the raw text
 * so what was parsed stays auditable.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';

type Line = { position: number; description: string; qty: number; unitPrice: number; vatRate: number; amount: number;
  kind: 'labour' | 'part' | 'misc' | 'fixed'; labourHours: string; partsCost: string; costBasis: 'actual' | 'estimated' };

const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm';
const FROM_PDF = 'read from the document';

export default function HistoricalImport() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pre, setPre] = useState<any>(null);
  const [rawText, setRawText] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [form, setForm] = useState<any>({});
  const [supersede, setSupersede] = useState<string>('');

  /** Extract a LAYOUT-PRESERVING text layer in the browser. The parser keys off column gaps, so a
   *  naive concatenation of text items would destroy the very thing it reads. */
  async function extract(file: File): Promise<string> {
    const pdfjs: any = await import('pdfjs-dist');
    // The worker is served from /public, copied from pdfjs-dist at build time (scripts/copy-pdf-worker).
    // It is NOT imported: webpack cannot bundle an ESM worker entry, and a CDN would put a customer's
    // invoice through a third party. Same-origin, no external request.
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Group items into rows by y, then lay them out on a character grid by x — this reproduces
      // what `pdftotext -layout` emits, which is what the parser was written against.
      const rows = new Map<number, Array<{ x: number; s: string }>>();
      for (const it of content.items as any[]) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5]);
        const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
        (rows.get(key) ?? rows.set(key, []).get(key)!).push({ x: it.transform[4], s: it.str });
      }
      const ordered = [...rows.entries()].sort((a, b) => b[0] - a[0]);
      for (const [, items] of ordered) {
        items.sort((a, b) => a.x - b.x);
        let out = '';
        for (const it of items) {
          const col = Math.round(it.x / 4.8); // ≈ one character per 4.8pt at this font size
          if (col > out.length) out += ' '.repeat(col - out.length);
          out += it.s;
        }
        pages.push(out.replace(/\s+$/, ''));
      }
    }
    return pages.join('\n');
  }

  async function onFile(f: File | null) {
    if (!f) return;
    setBusy('extract'); setErr(null); setOk(null); setPre(null); setLines([]);
    try {
      const text = await extract(f);
      setRawText(text);
      const res = await fetch('/api/historical-prefill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawText: text }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || 'Could not read that PDF.'); setBusy(null); return; }
      if (d.alreadyRecordedAs) { setErr(`Refused: invoice ${d.parsed.externalNumber} is already recorded as ${d.alreadyRecordedAs}.`); setBusy(null); return; }
      setPre(d);
      setLines(d.parsed.lines.map((l: any) => ({ ...l, kind: 'fixed', labourHours: '', partsCost: '', costBasis: 'estimated' })));
      setForm({
        externalRef: d.parsed.externalNumber ?? '', dateIssued: d.parsed.dateIssued ?? '',
        registration: d.parsed.registration ?? '', customerName: d.known?.customer?.name ?? d.parsed.customerName ?? '',
        vin: d.parsed.vin ?? d.known?.vin ?? '', mileage: d.parsed.mileage ?? '',
        make: d.known?.make ?? '', model: d.known?.model ?? '',
        paymentMethodId: '', datePaid: '', siteId: d.sites?.[0]?.id ?? '',
      });
      // DVSA fills make/model from the registration — it is keyed on exactly what the PDF gives us.
      if (d.parsed.registration && !d.known?.make) {
        fetch(`/api/dvsa-lookup?reg=${encodeURIComponent(d.parsed.registration)}`)
          .then((r) => r.json()).then((v) => { if (v?.make) setForm((f2: any) => ({ ...f2, make: v.make ?? '', model: v.model ?? '' })); })
          .catch(() => {});
      }
    } catch (e: any) { setErr(`Could not read that PDF: ${e?.message ?? e}`); }
    finally { setBusy(null); }
  }

  const money = (n: number) => formatMoney(Math.round(n * 100), { currency: 'GBP', locale: 'en-GB' });
  const parsedSum = Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  const printed = pre?.parsed?.subtotalPrinted ?? 0;
  const balances = Math.abs(parsedSum - printed) < 0.005;
  const missingHours = lines.filter((l) => l.kind === 'labour' && !(Number(l.labourHours) > 0));
  const canCommit = pre && balances && missingHours.length === 0 && form.externalRef && form.dateIssued && form.registration && form.customerName;

  async function commit() {
    setBusy('commit'); setErr(null);
    try {
      const res = await fetch('/api/historical-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form, rawText,
          subtotalPrinted: pre.parsed.subtotalPrinted, vatPrinted: pre.parsed.vatPrinted, totalPrinted: pre.parsed.totalPrinted,
          datePaid: form.datePaid || null, paymentMethodId: form.paymentMethodId || null,
          supersedeInvoiceId: supersede || undefined,
          lines: lines.map((l) => ({ position: l.position, description: l.description, qty: l.qty, unitPrice: l.unitPrice,
            vatRate: l.vatRate, amount: l.amount, kind: l.kind,
            labourHours: l.labourHours === '' ? null : Number(l.labourHours),
            partsCost: l.partsCost === '' ? null : Number(l.partsCost),
            costBasis: l.partsCost === '' ? null : l.costBasis })),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || 'Could not record that invoice.'); setBusy(null); return; }
      setOk(`Recorded as ${d.number}${d.superseded ? ` — ${d.superseded} voided as superseded` : ''}.`);
      setPre(null); setLines([]); setRawText(''); setBusy(null);
    } catch { setErr('Could not record that invoice.'); setBusy(null); }
  }

  return (
    <>
      <Head><title>Historical invoices — GreaseDesk</title></Head>
      <h1 className="text-xl font-semibold text-ink mb-1">Record a historical invoice</h1>
      <p className="text-sm text-muted mb-5 max-w-3xl">
        For invoices raised under your previous system. The original stays the customer’s document —
        this records it so the dashboard, the P&amp;L and your capacity figures can see those months.
        It keeps the original number, takes its own internal number from a separate series, and is
        never included in a VAT return or sent to anyone.
      </p>

      {err && <div className="bg-danger-soft text-danger rounded-lg p-3 text-sm mb-4" data-testid="hist-error">{err}</div>}
      {ok && <div className="bg-ok-soft text-ok rounded-lg p-3 text-sm mb-4" data-testid="hist-ok">{ok}</div>}

      {!pre && (
        <div className="bg-surface border border-line rounded-xl p-6 max-w-xl">
          <label className="block text-sm font-semibold text-ink mb-2">Source invoice (PDF)</label>
          <input type="file" accept="application/pdf" data-testid="hist-file" disabled={busy !== null}
            onChange={(e) => onFile(e.target.files?.[0] ?? null)} className="text-sm text-ink" />
          <p className="text-xs text-muted mt-2">{busy === 'extract' ? 'Reading…' : 'One invoice at a time.'}</p>
        </div>
      )}

      {pre && (
        <div className="space-y-5 max-w-5xl">
          <div className="bg-surface border border-line rounded-xl p-5">
            <h2 className="text-sm font-semibold text-ink mb-3">From the document</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {([['externalRef','Original invoice number'],['dateIssued','Date on the invoice'],['registration','Registration'],
                 ['customerName','Customer'],['vin','VIN'],['mileage','Mileage']] as Array<[string,string]>).map(([k,label]) => (
                <label key={k} className="block">
                  <span className="block text-xs font-semibold text-ink">{label}</span>
                  <input data-testid={`hist-${k}`} className={inputCls} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                  <span className="block text-[11px] text-muted mt-0.5">
                    {k === 'customerName' && pre.parsed.customerNamePartial
                      ? 'Only a partial name was printed — check it'
                      : (pre.parsed as any)[k] ? FROM_PDF : 'not on the document'}
                  </span>
                </label>
              ))}
              {([['make','Make'],['model','Model']] as Array<[string,string]>).map(([k,label]) => (
                <label key={k} className="block">
                  <span className="block text-xs font-semibold text-ink">{label}</span>
                  <input data-testid={`hist-${k}`} className={inputCls} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                  <span className="block text-[11px] text-muted mt-0.5">from the registration lookup</span>
                </label>
              ))}
            </div>
          </div>

          <div className="bg-surface border border-line rounded-xl p-5">
            <h2 className="text-sm font-semibold text-ink mb-1">Lines</h2>
            <p className="text-xs text-muted mb-3">
              Description, quantity, price and VAT are {FROM_PDF}. Kind, labour hours and parts cost are not on it and are yours to supply.
            </p>
            <div className="space-y-3">
              {lines.map((l, i) => (
                <div key={i} className="border border-line rounded-lg p-3" data-testid="hist-line">
                  <p className="text-sm text-ink mb-2">{l.description}</p>
                  <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                    <div className="text-xs text-muted">qty {l.qty}<br/>{money(l.unitPrice)} · {l.vatRate}% VAT<br/><span className="text-ink font-semibold">{money(l.amount)}</span></div>
                    <label className="block"><span className="block text-[11px] font-semibold text-ink">Kind</span>
                      <select data-testid="hist-kind" className={inputCls} value={l.kind}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, kind: e.target.value as any } : x))}>
                        <option value="fixed">Fixed price</option><option value="labour">Labour</option>
                        <option value="part">Part</option><option value="misc">Other</option>
                      </select></label>
                    <label className="block"><span className="block text-[11px] font-semibold text-ink">Labour hours{l.kind === 'labour' ? ' *' : ''}</span>
                      <input data-testid="hist-hours" type="number" step="0.25" min="0" className={inputCls} value={l.labourHours}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, labourHours: e.target.value } : x))} /></label>
                    <label className="block"><span className="block text-[11px] font-semibold text-ink">Parts cost</span>
                      <input data-testid="hist-cost" type="number" step="0.01" min="0" className={inputCls} value={l.partsCost}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, partsCost: e.target.value } : x))} /></label>
                    <label className="block"><span className="block text-[11px] font-semibold text-ink">Cost is</span>
                      <select className={inputCls} value={l.costBasis} disabled={l.partsCost === ''}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, costBasis: e.target.value as any } : x))}>
                        <option value="estimated">Estimated</option><option value="actual">Actual</option>
                      </select></label>
                  </div>
                </div>
              ))}
            </div>
            {/* THE RECONCILE GATE, shown live. The document is right; the lines must match it. */}
            <p className={`text-sm mt-3 ${balances ? 'text-ok' : 'text-danger'}`} data-testid="hist-reconcile">
              Lines total {money(parsedSum)} · invoice prints {money(printed)} — {balances ? 'balances' : `out by ${money(parsedSum - printed)}`}
            </p>
            {missingHours.length > 0 && (
              <p className="text-sm text-warn mt-2" data-testid="hist-hours-warning">
                {missingHours.length} labour line(s) still need hours. They are the denominator every utilisation
                figure divides by — a labour line without them reports revenue against no time.
              </p>
            )}
          </div>

          <div className="bg-surface border border-line rounded-xl p-5">
            <h2 className="text-sm font-semibold text-ink mb-3">Payment</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block"><span className="block text-xs font-semibold text-ink">Method</span>
                <select data-testid="hist-method" className={inputCls} value={form.paymentMethodId ?? ''} onChange={(e) => setForm({ ...form, paymentMethodId: e.target.value })}>
                  <option value="">Not recorded</option>
                  {pre.methods.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>
              <label className="block"><span className="block text-xs font-semibold text-ink">Paid date</span>
                <input data-testid="hist-paid" type="date" className={inputCls} value={form.datePaid ?? ''} onChange={(e) => setForm({ ...form, datePaid: e.target.value })} />
                {/* Never defaulted to the issue date — that would invent a cash-basis fact. */}
                <span className="block text-[11px] text-muted mt-0.5">Leave blank if you don’t know it</span></label>
              {pre.sites?.length > 1 && (
                <label className="block"><span className="block text-xs font-semibold text-ink">Site</span>
                  <select className={inputCls} value={form.siteId ?? ''} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
                    {pre.sites.map((s: any) => <option key={s.id} value={s.id}>{s.site_name}</option>)}
                  </select></label>
              )}
            </div>
          </div>

          {pre.candidates?.length > 0 && (
            <div className="bg-warn-soft border border-warn rounded-xl p-5" data-testid="hist-supersede">
              <h2 className="text-sm font-semibold text-warn mb-1">There is already an entry for this vehicle on this date</h2>
              <p className="text-xs text-warn mb-3">
                Most likely a hand-keyed row from before this screen existed. Superseding voids it with a reason
                and replaces it with this record. Its number stays consumed and its document is retained.
              </p>
              <select data-testid="hist-supersede-pick" className={`${inputCls} max-w-md`} value={supersede} onChange={(e) => setSupersede(e.target.value)}>
                <option value="">Don’t supersede anything — record this alongside</option>
                {pre.candidates.map((c: any) => (
                  <option key={c.id} value={c.id}>{c.invoiceNumber} · {formatMoney(c.grossPennies, { currency: 'GBP', locale: 'en-GB' })} · {c.series}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button data-testid="hist-commit" disabled={!canCommit || busy !== null} onClick={commit}
              className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-40">
              {busy === 'commit' ? 'Recording…' : 'Record this invoice'}
            </button>
            <button onClick={() => { setPre(null); setLines([]); setRawText(''); setErr(null); }} className="text-sm text-muted px-3 py-2.5">Start again</button>
            <Link href="/admin/invoices" className="text-sm text-accent px-3 py-2.5 self-center">Back to invoices</Link>
          </div>
        </div>
      )}
    </>
  );
}

export const getServerSideProps = withI18n(['invoices'])(async (ctx: any) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return { redirect: { destination: '/admin/invoices', permanent: false } };
  return { props: {} };
});
