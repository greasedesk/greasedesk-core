/**
 * File: pages/admin/stock/[id].tsx
 * ONE CAR IN STOCK — what it cost, what has gone into it, and what it will make.
 *
 * NO <AdminLayout> here: pages/_app.tsx already wraps every /admin route, and admin-shell-gate
 * catches a page that renders the shell inside itself.
 *
 * WHAT IS NOT EDITABLE, and why it is refused by the WRITER and not merely missing from this form:
 * a field absent from a form is one a later form can put back. lib/stock-store::updateStockItem
 * refuses the VAT treatment, the source, and everything on a disposed car. This page only has to
 * explain the refusal; it does not enforce it.
 */
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { SOURCE_RULES, type PurchaseSource } from '@/lib/purchase-model';
import { LABOUR_AT_ZERO_NOTE } from '@/lib/stock';
import { MISSING_COST_KINDS } from '@/lib/stock-projection';

const money = (p: number) => `£${(p / 100).toFixed(2)}`;
const iso = (d: string) => d.slice(0, 10);

type Detail = {
  stockItemId: string; vehicleId: string; registration: string; description: string | null;
  acquiredAt: string; daysInStock: number; purchasePence: number; premiumPence: number;
  servicesPence: number; vatStatus: string; source: string; mileageWarranted: boolean | null;
  projectedSalePence: number | null;
  prep: { partsPence: number; unknownCostLines: number; labourLines: number; cards: number };
  projection: null | {
    salePence: number; grossProfitPence: number; totalCostsPence: number; vatDuePence: number;
    partsPence: number; missingCostKinds: string[]; note: string;
  };
  disposedAt: string | null; disposalKind: string | null; salePence: number | null;
};

export default function StockCarPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const [d, setD] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ acquiredAt: '', purchase: '', premium: '', services: '', warranted: 'unknown', projected: '' });

  const load = useCallback(async () => {
    if (!id) return;
    const res = await fetch(`/api/stock?id=${encodeURIComponent(id)}`);
    if (!res.ok) { setMsg('That car is not on this account.'); return; }
    const body = await res.json();
    const det: Detail = body.detail;
    setD(det);
    setForm({
      acquiredAt: iso(det.acquiredAt),
      purchase: (det.purchasePence / 100).toFixed(2),
      premium: (det.premiumPence / 100).toFixed(2),
      services: (det.servicesPence / 100).toFixed(2),
      warranted: det.mileageWarranted === null ? 'unknown' : det.mileageWarranted ? 'yes' : 'no',
      projected: det.projectedSalePence === null ? '' : (det.projectedSalePence / 100).toFixed(2),
    });
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/stock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', stockItemId: id, acquiredAt: form.acquiredAt,
          purchasePence: Math.round(Number(form.purchase || 0) * 100),
          premiumPence: Math.round(Number(form.premium || 0) * 100),
          servicesPence: Math.round(Number(form.services || 0) * 100),
          mileageWarranted: form.warranted,
          // BLANK CLEARS IT, back to "nobody has said" — see updateStockItem.
          projectedSalePence: form.projected === '' ? 0 : Math.round(Number(form.projected) * 100),
        }),
      });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? 'Saved.' : (body.message ?? 'Could not save that.'));
      if (res.ok) await load();
    } catch {
      setMsg('Could not save that.');
    } finally {
      setBusy(false);   // cleared in finally, per the standing rule
    }
  }

  const input = 'mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink';
  const sold = !!d?.disposedAt;

  return (
    <>
      <Head><title>{d ? `${d.registration} · Stock` : 'Stock'}</title></Head>
      <div className="p-4 sm:p-6 max-w-3xl">
        <Link href="/admin/stock" className="text-sm text-muted underline" data-testid="back-to-yard">← The yard</Link>
        {!d ? <p className="mt-4 text-muted" data-testid="detail-loading">{msg ?? 'Loading…'}</p> : (
          <>
            <h1 className="mt-2 text-2xl font-bold text-ink" data-testid="detail-reg">{d.registration}</h1>
            <p className="text-muted">{d.description ?? '—'} · {SOURCE_RULES[d.source as PurchaseSource]?.label ?? d.source}</p>

            {sold && (
              <div className="mt-3 rounded-xl border border-line bg-surface p-3 text-sm text-ink" data-testid="detail-sold">
                Sold {iso(d.disposedAt as string)}{d.salePence !== null ? ` for ${money(d.salePence)}` : ''}. Its figures were
                frozen at disposal and nothing here can change now — re-running a past quarter has to give what it gave then.
              </div>
            )}

            {/* ── WHAT IT WILL MAKE ──────────────────────────────────────────────────────────── */}
            <section className="mt-5 rounded-xl border border-line bg-surface p-4" data-testid="projection">
              <h2 className="text-sm font-semibold text-ink">Gross profit on this car</h2>
              {d.projection ? (
                <>
                  <p className="text-3xl font-bold text-ink tabular-nums mt-1" data-testid="projected-profit">
                    {money(d.projection.grossProfitPence)}
                  </p>
                  <p className="text-sm text-muted">
                    If it sells for {money(d.projection.salePence)}. Before your fixed monthly costs and tax.
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted">Paid for the car</dt><dd className="text-right text-ink tabular-nums">{money(d.purchasePence)}</dd>
                    {d.premiumPence > 0 && (<><dt className="text-muted">Buyer’s premium</dt><dd className="text-right text-ink tabular-nums">{money(d.premiumPence)}</dd></>)}
                    {d.servicesPence > 0 && (<><dt className="text-muted">Fees</dt><dd className="text-right text-ink tabular-nums">{money(d.servicesPence)}</dd></>)}
                    <dt className="text-muted">Parts fitted (trade cost)</dt><dd className="text-right text-ink tabular-nums" data-testid="detail-prep">{money(d.prep.partsPence)}</dd>
                    <dt className="text-muted">VAT due on the sale</dt><dd className="text-right text-ink tabular-nums">{money(d.projection.vatDuePence)}</dd>
                  </dl>
                  {/* THE NUMBER MUST SAY WHAT IS NOT IN IT. Optimistic in a way the reader cannot see
                      is worse than absent — see lib/stock-projection. */}
                  <p className="mt-3 text-xs text-muted" data-testid="projection-note">{d.projection.note}</p>
                </>
              ) : (
                <p className="text-sm text-muted mt-1" data-testid="projection-absent">
                  {sold
                    ? 'This car is sold — the price it actually fetched is the answer, not what we expected.'
                    : 'Say what you expect to sell it for and this will work out what it makes. Nothing is assumed: with no figure there is no projection, because a £0 sale would read as a loss.'}
                </p>
              )}
            </section>

            {/* ── WHAT HAS GONE INTO IT ──────────────────────────────────────────────────────── */}
            <section className="mt-4 rounded-xl border border-line bg-surface p-4" data-testid="prep-section">
              <h2 className="text-sm font-semibold text-ink">Work on this car</h2>
              <p className="text-sm text-ink mt-1">
                {d.prep.cards === 0 ? 'No prep cards linked to this car yet.'
                  : `${money(d.prep.partsPence)} of parts across ${d.prep.cards} card${d.prep.cards === 1 ? '' : 's'}.`}
                {d.prep.unknownCostLines > 0 && (
                  <span className="text-danger" data-testid="prep-unknown"> {d.prep.unknownCostLines} line(s) have no trade cost recorded, so the figure is a floor, not a total.</span>
                )}
              </p>
              <p className="mt-1 text-xs text-muted" data-testid="labour-note">{LABOUR_AT_ZERO_NOTE}</p>
              <p className="mt-1 text-xs text-muted" data-testid="missing-costs">
                Not yet recordable against a car at all: {MISSING_COST_KINDS.join(', ').toLowerCase()}.
              </p>
            </section>

            {/* ── WHAT CAN BE CORRECTED ──────────────────────────────────────────────────────── */}
            <section className="mt-4 rounded-xl border border-line bg-surface p-4" data-testid="edit-section">
              <h2 className="text-sm font-semibold text-ink">Correct the record</h2>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="text-sm text-muted">Bought on
                  <input type="date" value={form.acquiredAt} disabled={sold} data-testid="edit-acquired"
                    onChange={(e) => setForm({ ...form, acquiredAt: e.target.value })} className={input} />
                </label>
                <label className="text-sm text-muted">Price paid
                  <input type="number" step="0.01" min={0} value={form.purchase} disabled={sold} data-testid="edit-purchase"
                    onChange={(e) => setForm({ ...form, purchase: e.target.value })} className={input} />
                </label>
                <label className="text-sm text-muted">Buyer’s premium
                  <input type="number" step="0.01" min={0} value={form.premium} disabled={sold} data-testid="edit-premium"
                    onChange={(e) => setForm({ ...form, premium: e.target.value })} className={input} />
                </label>
                <label className="text-sm text-muted">Fees
                  <input type="number" step="0.01" min={0} value={form.services} disabled={sold} data-testid="edit-services"
                    onChange={(e) => setForm({ ...form, services: e.target.value })} className={input} />
                </label>
                <label className="text-sm text-muted">Mileage warranted
                  <select value={form.warranted} disabled={sold} data-testid="edit-warranted"
                    onChange={(e) => setForm({ ...form, warranted: e.target.value })} className={input}>
                    <option value="unknown">Not stated</option>
                    <option value="yes">Warranted</option>
                    <option value="no">Not warranted</option>
                  </select>
                </label>
                <label className="text-sm text-muted">Expected sale price
                  <input type="number" step="0.01" min={0} value={form.projected} disabled={sold} data-testid="edit-projected"
                    placeholder="Not estimated"
                    onChange={(e) => setForm({ ...form, projected: e.target.value })} className={input} />
                </label>
              </div>

              {/* THE FROZEN PAIR, SHOWN AND EXPLAINED. Hiding them would leave a person hunting for a
                  control that is deliberately absent; saying why is the whole point. */}
              <div className="mt-3 rounded-lg border border-line p-3 text-sm" data-testid="frozen-fields">
                <p className="text-ink font-medium">
                  VAT treatment: {d.vatStatus === 'margin' ? 'Margin scheme' : 'VAT qualifying'} · Bought from: {SOURCE_RULES[d.source as PurchaseSource]?.label ?? d.source}
                </p>
                <p className="text-xs text-muted mt-1">
                  Both are fixed from when you bought the car. Reclaiming input VAT forecloses the margin scheme for it
                  and the choice may already be in a filed return, so changing it is your accountant’s call and not a
                  correction. Where it came from decides which treatments are even allowed, so it is fixed with it.
                </p>
              </div>

              {!sold && (
                <button onClick={() => void save()} disabled={busy} data-testid="edit-save"
                  className="mt-3 min-h-[44px] px-4 rounded-lg bg-accent text-white font-semibold disabled:opacity-60">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              )}
              {msg && <p className="mt-2 text-sm text-ink" data-testid="edit-msg">{msg}</p>}
            </section>
          </>
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
