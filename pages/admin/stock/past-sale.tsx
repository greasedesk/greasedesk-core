/**
 * File: pages/admin/stock/past-sale.tsx
 *
 * RECORD A PAST SALE — a car bought, prepared and sold BEFORE this garage invoiced car sales through
 * GreaseDesk. NO <AdminLayout> here: pages/_app.tsx already wraps every /admin route. The rules are lib/stock-historical-rules and lib/stock-paperwork; the writer is
 * lib/stock-historical. This page explains refusals early; the server decides.
 *
 * WHAT IT IS NOT: a way to sell a car. Nothing is minted — the buyer already holds a receipt — and the
 * page opens only once the first car sale has been invoiced here, whose date is the boundary.
 *
 * EVERY PAPERWORK FIELD HAS A TICK. "Not on the paperwork" is a statement that somebody looked and it was
 * not there; the book prints it as "not supplied". A field left blank without the tick cannot be sent.
 */
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { SOURCES, SOURCE_RULES, VAT_TREATMENTS, type PurchaseSource } from '@/lib/purchase-model';
import { isReacquisition } from '@/lib/stock-reacquisition';
import { HISTORICAL_COST_KINDS, costKindLabel, VAT_TREATMENT_LABELS } from '@/lib/stock-cost';
import {
  PAPERWORK_LABELS, PURCHASE_PAPERWORK_KEYS, SALE_PAPERWORK_KEYS, checkPaperwork, type PaperworkKey,
} from '@/lib/stock-paperwork';
import {
  HISTORICAL_NO_BOUNDARY_REFUSAL, boundaryReason, boundaryRefusal, dayLabel, declarationSentence, historicalBasicsRefusal,
  type Boundary,
} from '@/lib/stock-historical-rules';

type Found = { id: string; name: string; address: string | null; phone: string | null; email: string | null };
type CostDraft = { kind: string; description: string; amount: string; incurredOn: string; vatTreatment: string };

const pence = (pounds: string): number => Math.round(Number(pounds) * 100);
const asDate = (iso: string): Date | null => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00.000Z`) : null);
const money = (p: number) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PastSalePage() {
  const router = useRouter();
  const [boundary, setBoundary] = useState<null | { date: string; basis: Boundary['basis']; invoiceNumber: string | null; declared: string }>(null);
  const [canDeclare, setCanDeclare] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [declaring, setDeclaring] = useState(false);
  const [earlier, setEarlier] = useState('');
  const [boundaryMsg, setBoundaryMsg] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [f, setF] = useState({
    registration: '', make: '', model: '', acquiredAt: '', arrivedAt: '', source: 'private', vatStatus: 'margin',
    purchase: '', premium: '', sellerName: '', purchaseRef: '', mileage: '',
    soldAt: '', sale: '', receiptRef: '',
  });
  const [ticks, setTicks] = useState<Set<PaperworkKey>>(new Set());
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found | null>(null);
  const [nb, setNb] = useState({ name: '', address: '', phone: '', email: '' });
  const [costs, setCosts] = useState<CostDraft[]>([]);
  const [stage, setStage] = useState<'form' | 'confirm'>('form');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/stock?historicalBoundary=1');
        const body = res.ok ? await res.json() : {};
        if (live) { setBoundary(body.boundary ?? null); setCanDeclare(!!body.canDeclare); }
      } finally { if (live) setLoaded(true); }
    })();
    return () => { live = false; };
  }, [reload]);

  async function boundaryAction(action: 'declare-boundary' | 'move-boundary-earlier') {
    setBoundaryMsg(null);
    try {
      const res = await fetch('/api/stock', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'declare-boundary' ? { action } : { action, date: earlier }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setBoundaryMsg(body.message ?? 'That did not save.'); return; }
      setDeclaring(false); setEarlier(''); setReload((n) => n + 1);
    } catch { setBoundaryMsg('That did not save.'); }
  }
  const asBoundary = (b: NonNullable<typeof boundary>): Boundary =>
    ({ date: new Date(b.date), basis: b.basis, invoiceNumber: b.invoiceNumber, declared: new Date(b.declared) });

  useEffect(() => {
    if (picked || q.trim().length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers/search?q=${encodeURIComponent(q.trim())}`);
        const body = res.ok ? await res.json() : { customers: [] };
        if (live) setFound(body.customers ?? []);
      } catch { if (live) setFound([]); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, picked]);

  // ANY EDIT RETURNS TO THE FORM, so the sentence on screen always describes what would be sent.
  useEffect(() => { setStage('form'); }, [f, ticks, picked?.id, nb, costs]);

  const tick = (k: PaperworkKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = new Set(ticks);
    if (e.target.checked) next.add(k); else next.delete(k);
    setTicks(next);
  };
  const ticked = (k: PaperworkKey) => ticks.has(k);

  const buyerNameTicked = ticked('buyer_name');
  const buyer = buyerNameTicked ? (nb.address.trim() ? { name: '', address: nb.address } : null)
    : picked ? { customerId: picked.id } : { name: nb.name, address: nb.address, phone: nb.phone, email: nb.email };

  const acquiredAt = asDate(f.acquiredAt);
  const soldAt = asDate(f.soldAt);
  const purchaseTicks = PURCHASE_PAPERWORK_KEYS.filter((k) => ticks.has(k));
  const saleTicks = SALE_PAPERWORK_KEYS.filter((k) => ticks.has(k));

  const blocker = (!boundary ? HISTORICAL_NO_BOUNDARY_REFUSAL : null)
    ?? historicalBasicsRefusal({ registration: f.registration, acquiredAt, soldAt, purchasePence: pence(f.purchase), salePence: pence(f.sale), vatStatus: f.vatStatus, source: f.source })
    ?? (soldAt && boundary ? boundaryRefusal(soldAt, asBoundary(boundary)) : null)
    ?? checkPaperwork(PURCHASE_PAPERWORK_KEYS, {
      seller_name: f.sellerName, purchase_ref: f.purchaseRef, mileage: f.mileage.trim() ? Number(f.mileage) : undefined,
      make_model: f.make.trim() && f.model.trim() ? `${f.make} ${f.model}` : undefined,
    }, purchaseTicks)
    ?? (picked
      ? checkPaperwork(['receipt_ref'], { receipt_ref: f.receiptRef }, saleTicks.filter((k) => k === 'receipt_ref'))
        ?? (!(picked.address ?? '').trim() && !ticked('buyer_address') ? 'That customer has no address on file. Add it to the customer, or tick “not on the paperwork” if the receipt did not carry one.' : null)
      : checkPaperwork(SALE_PAPERWORK_KEYS, { buyer_name: nb.name, buyer_address: nb.address, receipt_ref: f.receiptRef }, saleTicks))
    ?? costs.map((c, i) => (!c.description.trim() || !(pence(c.amount) > 0) || !asDate(c.incurredOn)
      ? `Cost ${i + 1}: give it a description, an amount and the date you paid it.` : null)).find(Boolean) ?? null;

  const buyerWords = buyerNameTicked ? 'a buyer not named on the paperwork' : picked ? picked.name : nb.name.trim();
  const sentence = !blocker && acquiredAt && soldAt
    ? `${f.registration.trim().toUpperCase()}, bought ${dayLabel(acquiredAt)} for ${money(pence(f.purchase))}, sold ${dayLabel(soldAt)} to ${buyerWords} for ${money(pence(f.sale))}`
      + `${costs.length ? `, with ${costs.length} cost${costs.length === 1 ? '' : 's'} totalling ${money(costs.reduce((t, c) => t + pence(c.amount), 0))}` : ''}. `
      + 'Recorded, not invoiced — no GreaseDesk number is issued.'
    : null;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/stock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'record-historical',
          registration: f.registration, make: f.make, model: f.model,
          acquiredAt: f.acquiredAt, arrivedAt: f.arrivedAt || null, source: f.source, vatStatus: f.vatStatus,
          purchasePence: pence(f.purchase), premiumPence: f.premium ? pence(f.premium) : 0,
          sellerName: f.sellerName, purchaseRef: f.purchaseRef, mileageMiles: f.mileage.trim() ? Number(f.mileage) : null,
          soldAt: f.soldAt, salePence: pence(f.sale), receiptRef: f.receiptRef,
          buyer, notOnPaperwork: { purchase: purchaseTicks, sale: saleTicks },
          costs: costs.map((c) => ({ kind: c.kind, description: c.description, amountPence: pence(c.amount), incurredOn: c.incurredOn, vatTreatment: c.vatTreatment })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(body.message ?? 'The sale was not recorded.'); setStage('form'); return; }
      await router.push(`/admin/stock/${body.stockItemId}`);
    } catch {
      setErr('The sale was not recorded.');
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink disabled:opacity-50';
  /** A paperwork field: the input, and beside it the statement that it is not on the paperwork. */
  const paper = (k: PaperworkKey, control: React.ReactNode) => (
    <div className="text-xs uppercase text-muted" data-testid={`field-${k}`}>
      {PAPERWORK_LABELS[k]}
      {control}
      <label className="mt-1 flex items-center gap-2 normal-case text-xs text-muted">
        <input type="checkbox" checked={ticked(k)} onChange={tick(k)} data-testid={`nop-${k}`} />
        Not on the paperwork
      </label>
    </div>
  );
  const fees = SOURCE_RULES[f.source as PurchaseSource]?.fees ?? [];

  return (
    <>
      <Head><title>Record a past sale · GreaseDesk</title></Head>
      <div className="p-4 sm:p-6 max-w-3xl" data-testid="past-sale">
        <Link href="/admin/stock" className="text-sm text-muted underline">← The yard</Link>
        <h1 className="mt-2 text-xl font-bold text-ink">Record a past sale</h1>
        <p className="mt-1 text-sm text-muted">
          For a car you sold before car sales were invoiced through GreaseDesk. It fills the sold figures and the stock
          book. Nothing is invoiced and no number is issued — your buyer already has your receipt.
        </p>

        {loaded && (
          <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-sm text-ink">
            <p data-testid="past-sale-boundary">
              {boundary
                ? `Sales dated before ${dayLabel(new Date(boundary.date))} can be recorded here — ${boundaryReason(asBoundary(boundary))}. Anything on or after it goes through “Sell this car”.`
                : HISTORICAL_NO_BOUNDARY_REFUSAL}
            </p>
            {/* DECLARING: two steps, the sentence read back first. No date to choose — it is today. */}
            {!boundary && canDeclare && (declaring ? (
              <div className="mt-3 rounded-lg border-2 border-ink p-3" data-testid="ps-declare-confirm">
                <p className="font-semibold" data-testid="ps-declare-sentence">{declarationSentence(new Date())}</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button type="button" onClick={() => boundaryAction('declare-boundary')} data-testid="ps-declare-submit"
                    className="min-h-[44px] px-4 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold">Declare it</button>
                  <button type="button" onClick={() => setDeclaring(false)} className="min-h-[44px] px-4 rounded-lg border border-line text-ink">Not yet</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setDeclaring(true)} data-testid="ps-declare"
                className="mt-3 min-h-[44px] px-4 rounded-lg border border-line text-ink">Declare that car sales are invoiced from today</button>
            ))}
            {!boundary && !canDeclare && <p className="mt-2 text-muted">An admin on this account can declare it.</p>}
            {/* MOVING IT: earlier only. The server refuses later, future, and past a recorded sale. */}
            {boundary && canDeclare && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-xs uppercase text-muted">Move the declared date earlier
                  <input className={input} type="date" value={earlier} onChange={(e) => setEarlier(e.target.value)} data-testid="ps-boundary-earlier" />
                </label>
                <button type="button" disabled={!earlier} onClick={() => boundaryAction('move-boundary-earlier')} data-testid="ps-boundary-earlier-submit"
                  className="min-h-[44px] px-4 rounded-lg border border-line text-ink disabled:opacity-50">Move earlier</button>
              </div>
            )}
            {boundaryMsg && <p className="mt-2 text-danger" data-testid="ps-boundary-msg">{boundaryMsg}</p>}
          </div>
        )}

        <section className="mt-5 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">The car and its purchase</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs uppercase text-muted">Registration
              <input className={input} value={f.registration} onChange={(e) => setF({ ...f, registration: e.target.value })} data-testid="ps-registration" />
            </label>
            {paper('make_model', (
              <div className="grid grid-cols-2 gap-2">
                <input className={input} placeholder="Make" disabled={ticked('make_model')} value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} data-testid="ps-make" />
                <input className={input} placeholder="Model" disabled={ticked('make_model')} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} data-testid="ps-model" />
              </div>
            ))}
            <label className="text-xs uppercase text-muted">Date bought
              <input className={input} type="date" value={f.acquiredAt} onChange={(e) => setF({ ...f, acquiredAt: e.target.value })} data-testid="ps-acquired" />
            </label>
            <label className="text-xs uppercase text-muted">Date it arrived (optional)
              <input className={input} type="date" value={f.arrivedAt} onChange={(e) => setF({ ...f, arrivedAt: e.target.value })} data-testid="ps-arrived" />
            </label>
            <label className="text-xs uppercase text-muted">Bought from
              <select className={input} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} data-testid="ps-source">
                {SOURCES.filter((s) => !isReacquisition(s)).map((s) => <option key={s} value={s}>{SOURCE_RULES[s].label}</option>)}
              </select>
            </label>
            <label className="text-xs uppercase text-muted">Scheme
              <select className={input} value={f.vatStatus} onChange={(e) => setF({ ...f, vatStatus: e.target.value })} data-testid="ps-scheme">
                {(SOURCE_RULES[f.source as PurchaseSource]?.vatStatuses ?? []).map((v) => <option key={v} value={v}>{v === 'margin' ? 'Margin scheme' : 'VAT qualifying'}</option>)}
              </select>
            </label>
            <label className="text-xs uppercase text-muted">Price paid for the car
              <input className={input} inputMode="decimal" value={f.purchase} onChange={(e) => setF({ ...f, purchase: e.target.value })} data-testid="ps-purchase" />
            </label>
            {fees.some((x) => x.slot === 'premium') && (
              <label className="text-xs uppercase text-muted">{fees.find((x) => x.slot === 'premium')?.label}
                <input className={input} inputMode="decimal" value={f.premium} onChange={(e) => setF({ ...f, premium: e.target.value })} data-testid="ps-premium" />
              </label>
            )}
            {paper('seller_name', <input className={input} disabled={ticked('seller_name')} value={f.sellerName} onChange={(e) => setF({ ...f, sellerName: e.target.value })} data-testid="ps-seller" />)}
            {paper('purchase_ref', <input className={input} disabled={ticked('purchase_ref')} value={f.purchaseRef} onChange={(e) => setF({ ...f, purchaseRef: e.target.value })} data-testid="ps-purchase-ref" />)}
            {paper('mileage', <input className={input} inputMode="numeric" disabled={ticked('mileage')} value={f.mileage} onChange={(e) => setF({ ...f, mileage: e.target.value })} data-testid="ps-mileage" />)}
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">Prep and costs</h2>
          <p className="mt-1 text-xs text-muted">One row per supplier bill, with the date you paid it and whether you reclaimed the VAT on it.</p>
          {costs.map((c, i) => (
            <div key={i} className="mt-3 grid gap-2 sm:grid-cols-2 items-end text-sm rounded-lg border border-line p-2" data-testid={`ps-cost-${i}`}>
              <select className={input} value={c.kind} onChange={(e) => setCosts(costs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))} data-testid={`ps-cost-kind-${i}`}>
                {HISTORICAL_COST_KINDS.map((k) => <option key={k} value={k}>{costKindLabel(k)}</option>)}
              </select>
              <input className={input} placeholder="What for, and whose bill" value={c.description} onChange={(e) => setCosts(costs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} data-testid={`ps-cost-description-${i}`} />
              <input className={input} placeholder="Amount paid" inputMode="decimal" value={c.amount} onChange={(e) => setCosts(costs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} data-testid={`ps-cost-amount-${i}`} />
              <input className={input} type="date" value={c.incurredOn} onChange={(e) => setCosts(costs.map((x, j) => (j === i ? { ...x, incurredOn: e.target.value } : x)))} data-testid={`ps-cost-date-${i}`} />
              <select className={input} value={c.vatTreatment} onChange={(e) => setCosts(costs.map((x, j) => (j === i ? { ...x, vatTreatment: e.target.value } : x)))} data-testid={`ps-cost-vat-${i}`}>
                {VAT_TREATMENTS.map((v) => <option key={v} value={v}>{VAT_TREATMENT_LABELS[v]}</option>)}
              </select>
              <button type="button" className="text-xs text-accent underline justify-self-start" onClick={() => setCosts(costs.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="mt-3 text-sm text-accent underline" data-testid="ps-add-cost"
            onClick={() => setCosts([...costs, { kind: 'prep_parts', description: '', amount: '', incurredOn: '', vatTreatment: 'standard_not_recoverable' }])}>
            Add a bill
          </button>
        </section>

        <section className="mt-4 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">The sale</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs uppercase text-muted">Date sold
              <input className={input} type="date" value={f.soldAt} onChange={(e) => setF({ ...f, soldAt: e.target.value })} data-testid="ps-sold" />
            </label>
            <label className="text-xs uppercase text-muted">Sale price, including any VAT
              <input className={input} inputMode="decimal" value={f.sale} onChange={(e) => setF({ ...f, sale: e.target.value })} data-testid="ps-sale" />
            </label>
            {paper('receipt_ref', <input className={input} disabled={ticked('receipt_ref')} value={f.receiptRef} onChange={(e) => setF({ ...f, receiptRef: e.target.value })} data-testid="ps-receipt" />)}
          </div>

          <div className="mt-4">
            {paper('buyer_name', picked ? (
              <div className="mt-1 flex items-start justify-between gap-3 rounded-lg border border-line p-2 normal-case" data-testid="ps-buyer-picked">
                <div className="text-sm text-ink"><div className="font-medium">{picked.name}</div><div className="text-muted whitespace-pre-line">{picked.address || 'No address on file.'}</div></div>
                <button type="button" className="text-xs text-accent underline" onClick={() => { setPicked(null); setQ(''); }}>Change</button>
              </div>
            ) : (
              <div className="normal-case">
                <input className={input} placeholder="Find an existing customer" disabled={buyerNameTicked} value={q} onChange={(e) => setQ(e.target.value)} data-testid="ps-buyer-search" />
                {found.length > 0 && (
                  <ul className="mt-1 rounded-lg border border-line divide-y divide-line">
                    {found.map((c) => (
                      <li key={c.id}><button type="button" className="w-full text-left p-2 text-sm text-ink" onClick={() => setPicked(c)} data-testid="ps-buyer-result">{c.name}</button></li>
                    ))}
                  </ul>
                )}
                <input className={input} placeholder="…or the buyer’s name, as a new customer" disabled={buyerNameTicked} value={nb.name} onChange={(e) => setNb({ ...nb, name: e.target.value })} data-testid="ps-buyer-name" />
                <input className={input} placeholder="Phone (optional)" type="tel" disabled={buyerNameTicked} value={nb.phone} onChange={(e) => setNb({ ...nb, phone: e.target.value })} />
                <input className={input} placeholder="Email (optional)" type="email" disabled={buyerNameTicked} value={nb.email} onChange={(e) => setNb({ ...nb, email: e.target.value })} />
              </div>
            ))}
            <div className="mt-3" />
            {!picked && paper('buyer_address', <textarea className={input} rows={3} disabled={ticked('buyer_address')} value={nb.address} onChange={(e) => setNb({ ...nb, address: e.target.value })} data-testid="ps-buyer-address" />)}
            {picked && !(picked.address ?? '').trim() && paper('buyer_address', <span className="block normal-case text-sm text-muted">No address on file for this customer.</span>)}
          </div>
        </section>

        {err && <p className="mt-3 text-sm text-danger" data-testid="ps-error">{err}</p>}
        {stage === 'form' ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={!!blocker} onClick={() => { setErr(null); setStage('confirm'); }} data-testid="ps-review"
              className="min-h-[44px] px-4 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold disabled:opacity-50">
              Review
            </button>
            {blocker && <span className="text-xs text-muted" data-testid="ps-blocker">{blocker}</span>}
          </div>
        ) : sentence && (
          <div className="mt-4 rounded-lg border-2 border-ink p-4" data-testid="ps-confirm">
            <p className="text-sm font-semibold text-ink" data-testid="ps-confirm-sentence">{sentence}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" disabled={busy} onClick={save} data-testid="ps-submit"
                className="min-h-[44px] px-4 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold disabled:opacity-50">
                {busy ? 'Recording…' : 'Record this past sale'}
              </button>
              <button type="button" disabled={busy} onClick={() => setStage('form')} className="min-h-[44px] px-4 rounded-lg border border-line text-ink">
                Go back and change something
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n([])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
});
