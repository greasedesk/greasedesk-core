/**
 * File: components/stock/SellCarPanel.tsx
 *
 * SELL THIS CAR — on the car's own page, where its cost and projected price are already on screen.
 *
 * ONE ACTION, NO KIND TO CHOOSE. This is the sale path, and it offers nothing else: scrapped, returned
 * and own use are not sales and never raise an invoice, and "traded out" has no definition until
 * part-exchange gives it one — an option nobody can explain gets chosen.
 *
 * THE BUYER IS A REAL CUSTOMER, picked from the books or created. Picking matters: a car sold to
 * someone already on the books links to them, so their service history stays with the person.
 *
 * THE PREP WARNING NEVER BLOCKS. A car sells when it sells. But it names the consequence and the
 * remedy in words (lib/stock-sale-rules::openPrepWarning), because a generic are-you-sure is read as
 * furniture.
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { buyerRefusal, openPrepWarning, PICKED_BUYER_NO_ADDRESS, saleConfirmation, projectionHint, type OpenPrepCard } from '@/lib/stock-sale-rules';

type Found = { id: string; name: string; address: string | null; phone: string | null; email: string | null };

const today = () => new Date().toISOString().slice(0, 10);

export default function SellCarPanel(p: {
  stockItemId: string;
  registration: string;
  /** Make and model as the page shows them — named in the confirmation beside the plate. */
  description?: string | null;
  /** margin | qualifying — the scheme the confirmation states and the invoice will be taxed under. */
  vatStatus: string;
  projectedSalePence: number | null;
  openPrepCards: OpenPrepCard[];
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Found | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [nb, setNb] = useState({ name: '', address: '', phone: '', email: '' });
  // EMPTY, never pre-filled from the projection — see lib/stock-sale-rules::projectionHint for why.
  const [price, setPrice] = useState('');
  const [soldAt, setSoldAt] = useState(today());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // TWO STAGES. Nothing is sent from 'form'; the mint button exists only once the sentence is on screen.
  const [stage, setStage] = useState<'form' | 'confirm'>('form');

  // Search as the name is typed; stale answers are dropped rather than overwriting a newer one.
  useEffect(() => {
    if (isNew || picked || q.trim().length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers/search?q=${encodeURIComponent(q.trim())}`);
        const body = res.ok ? await res.json() : { customers: [] };
        if (live) setFound(body.customers ?? []);
      } catch { if (live) setFound([]); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, isNew, picked]);

  // A CHANGED FIELD INVALIDATES WHAT WAS READ. Editing anything while the confirmation is up returns to the
  // form, so the sentence on screen can never describe different values from the ones that would be sent.
  useEffect(() => { setStage('form'); }, [price, soldAt, nb.name, nb.address, picked?.id]);

  const warning = openPrepWarning(p.registration, p.openPrepCards);
  const buyer = picked ? { customerId: picked.id } : isNew ? nb : null;
  const pricePence = Math.round(Number(price) * 100);
  const blocker = buyerRefusal(buyer as never)
    ?? (picked && !(picked.address ?? '').trim() ? PICKED_BUYER_NO_ADDRESS : null)
    ?? (!(pricePence > 0) ? 'Say what the car sold for.' : null);

  const confirmation = !blocker && buyer ? saleConfirmation({
    registration: p.registration, description: p.description,
    buyerName: picked ? picked.name : nb.name, buyerAddress: picked ? (picked.address ?? '') : nb.address,
    pricePence, soldAtIsoDay: soldAt, vatStatus: p.vatStatus,
  }) : null;

  async function sell() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/stock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sell', stockItemId: p.stockItemId, soldAt, salePence: pricePence, buyer }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(body.message ?? 'The sale was not recorded.'); setStage('form'); return; }
      await router.push(`/admin/invoices/${body.invoiceId}`);
    } catch {
      setErr('The sale was not recorded.');
    } finally {
      setBusy(false);   // cleared in finally, per the standing rule
    }
  }

  const input = 'mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink';
  return (
    <section className="mt-5 rounded-xl border border-line bg-surface p-4" data-testid="sell-car">
      <h2 className="text-sm font-semibold text-ink">Sell this car</h2>
      <p className="text-xs text-muted mt-1">Records the sale, raises the invoice and moves the car to its buyer — all at once, or not at all.</p>

      {warning && (
        <div className="mt-3 rounded-lg border border-warn bg-warn-soft p-3 text-sm text-ink" data-testid="sale-prep-warning">{warning}</div>
      )}

      <div className="mt-4">
        <span className="text-xs uppercase text-muted">Buyer</span>
        {picked ? (
          <div className="mt-1 flex items-start justify-between gap-3 rounded-lg border border-line p-2" data-testid="sale-buyer-picked">
            <div className="text-sm text-ink">
              <div className="font-medium">{picked.name}</div>
              <div className="text-muted whitespace-pre-line">{picked.address || 'No address on file — add one to this customer before selling.'}</div>
            </div>
            <button type="button" className="text-xs text-accent underline" onClick={() => { setPicked(null); setQ(''); }}>Change</button>
          </div>
        ) : isNew ? (
          <div className="mt-1 grid gap-2" data-testid="sale-buyer-new-form">
            <input className={input} placeholder="Name" value={nb.name} onChange={(e) => setNb({ ...nb, name: e.target.value })} data-testid="sale-new-name" />
            <textarea className={input} placeholder="Address — printed on the invoice" rows={3} value={nb.address} onChange={(e) => setNb({ ...nb, address: e.target.value })} data-testid="sale-new-address" />
            <input className={input} placeholder="Phone (optional)" type="tel" value={nb.phone} onChange={(e) => setNb({ ...nb, phone: e.target.value })} />
            <input className={input} placeholder="Email (optional)" type="email" value={nb.email} onChange={(e) => setNb({ ...nb, email: e.target.value })} />
            <button type="button" className="text-xs text-accent underline justify-self-start" onClick={() => setIsNew(false)}>Find an existing customer instead</button>
          </div>
        ) : (
          <>
            <input className={input} placeholder="Search by name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} data-testid="sale-buyer-search" />
            {found.length > 0 && (
              <ul className="mt-1 rounded-lg border border-line divide-y divide-line">
                {found.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="w-full text-left p-2 text-sm text-ink hover:bg-surface-muted" onClick={() => setPicked(c)} data-testid="sale-buyer-result">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-muted">{[c.phone, c.email].filter(Boolean).length ? ` · ${[c.phone, c.email].filter(Boolean).join(' · ')}` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="mt-2 text-xs text-accent underline" onClick={() => setIsNew(true)} data-testid="sale-buyer-new">New customer</button>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs uppercase text-muted">Sale price agreed, including any VAT
          <input className={input} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="sale-price" />
          {/* BESIDE the box, never in it: an estimate cannot be submitted by leaving a field alone. */}
          {p.projectedSalePence !== null && (
            <span className="mt-1 block normal-case text-xs text-muted" data-testid="sale-projection">{projectionHint(p.projectedSalePence)}</span>
          )}
        </label>
        <label className="text-xs uppercase text-muted">Date sold
          <input className={input} type="date" value={soldAt} onChange={(e) => setSoldAt(e.target.value)} data-testid="sale-date" />
        </label>
      </div>

      {err && <p className="mt-3 text-sm text-danger" data-testid="sale-error">{err}</p>}
      {stage === 'form' ? (
        <div className="mt-4 flex items-center gap-3">
          <button type="button" disabled={!!blocker} onClick={() => { setErr(null); setStage('confirm'); }} data-testid="sale-review"
            className="min-h-[44px] px-4 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold disabled:opacity-50">
            Review the sale
          </button>
          {/* SAYS WHY it is disabled, rather than silently greying out. */}
          {blocker && <span className="text-xs text-muted" data-testid="sale-blocker">{blocker}</span>}
        </div>
      ) : confirmation && (
        /* ── READ THIS BEFORE THE NUMBER EXISTS ──────────────────────────────────────────────────
           Every field as a sentence, then the only button that mints. The form's inputs stay above,
           visible, but a change to any of them returns here only through "Go back". */
        <div className="mt-4 rounded-lg border-2 border-ink p-4" data-testid="sale-confirm">
          <p className="text-sm font-semibold text-ink" data-testid="sale-confirm-sentence">{confirmation.sentence}</p>
          <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
            {confirmation.rows.map(([k, v]) => (
              <React.Fragment key={k}><dt className="text-muted">{k}</dt><dd className="text-ink font-medium">{v}</dd></React.Fragment>
            ))}
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={sell} data-testid="sale-submit"
              className="min-h-[44px] px-4 rounded-lg bg-accent hover:bg-accent-hover text-white font-semibold disabled:opacity-50">
              {busy ? 'Minting…' : 'Mint the invoice'}
            </button>
            <button type="button" disabled={busy} onClick={() => setStage('form')} data-testid="sale-back"
              className="min-h-[44px] px-4 rounded-lg border border-line text-ink">
              Go back and change something
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
