/**
 * File: pages/admin/purchase.tsx
 * BUYING A CAR — what it makes after VAT, after money, and after the workshop's own time.
 *
 * ── THE POINT IS THE MOVEMENT, NOT THE ANSWER ───────────────────────────────────────────────────
 * Everything recomputes on every drag, with no Calculate button and no submit, because a garage
 * owner who drags days-in-stock from 30 to 90 and WATCHES the stocking cost eat the margin learns
 * something a final figure cannot teach. The numbers are large and the breakdown is always on
 * screen, so the thing that moved is visible without hunting for it.
 *
 * ── EVERY SLIDER MUST LOOK LIKE AN ASSUMPTION ───────────────────────────────────────────────────
 * Nothing here is measured, and nothing may be dressed to look as though it came from the garage's
 * own data. Each control shows its range and says what it covers; the page says once, plainly, that
 * it is all assumptions. The ranking carries a stronger version of the same warning — see below.
 *
 * ── MOBILE FIRST: AN AUCTION HALL, ONE HAND, A BAD SIGNAL ───────────────────────────────────────
 * Single column, 44px minimum on everything touchable, native range inputs (the one control that is
 * genuinely good with a thumb). The answer is sticky at the bottom on a phone, so it stays visible
 * while the sliders are being dragged above it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import {
  SLIDERS, computeModel, defaultInputs, sensitivity, clampSlider,
  type ModelInputs, type SliderKey, type VatStatus,
} from '@/lib/purchase-model';

type Saved = { id: string; label: string; vehicle_ident: string | null; purchase_pence: number; sale_pence: number; vat_status: string; profit_pence: number; updated_at: string };

const money = (p: number) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const moneyExact = (p: number) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const showSlider = (k: SliderKey, v: number) => {
  const s = SLIDERS.find((x) => x.key === k)!;
  if (s.unit === 'money') return money(v);
  if (s.unit === 'percent') return `${v}%`;
  if (s.unit === 'days') return `${v} days`;
  return `${v} h`;
};

export default function PurchaseModelPage() {
  const [inputs, setInputs] = useState<ModelInputs>(defaultInputs);
  const [label, setLabel] = useState('');
  const [ident, setIdent] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // PURE, AND RECOMPUTED EVERY RENDER. No effect, no debounce, no stale answer: the model is
  // arithmetic over the inputs, so the screen cannot lag behind the thumb.
  const r = useMemo(() => computeModel(inputs), [inputs]);
  const ranked = useMemo(() => sensitivity(inputs), [inputs]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/purchase-model', { cache: 'no-store' });
      if (res.ok) setSaved((await res.json()).models ?? []);
    } catch { /* the tool works offline-ish; the list is the only part that needs the server */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k: SliderKey) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInputs((p) => ({ ...p, [k]: clampSlider(k, Number(e.target.value)) }));
  const setMoney = (k: 'purchasePence' | 'salePence') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInputs((p) => ({ ...p, [k]: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) }));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/purchase-model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: openId, label, vehicleIdent: ident, inputs }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(d?.message || 'That did not save.'); return; }
      setOpenId(d.id); setMsg('Saved.'); load();
    } catch { setMsg('No signal — nothing was saved.'); } finally { setBusy(false); }
  }

  async function open(id: string) {
    const res = await fetch(`/api/purchase-model?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { model } = await res.json();
    setInputs(model.inputs); setLabel(model.label); setIdent(model.vehicle_ident ?? ''); setOpenId(model.id); setMsg(null);
  }

  const biggest = ranked[0];
  return (
    <>
      <Head><title>Buying a car — GreaseDesk</title></Head>
      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-4 pb-40 sm:pb-8">
        <h1 className="text-2xl font-bold text-ink">Buying a car</h1>
        {/* SAID ONCE, PLAINLY, AT THE TOP. */}
        <p className="mt-1 text-sm text-muted" data-testid="assumption-notice">
          Every figure on this page is one you have chosen. Nothing here is measured from your own data.
        </p>

        <section className="mt-5 grid grid-cols-2 gap-3">
          <label className="text-sm text-muted">Purchase price
            <input type="number" inputMode="decimal" min={0} value={Math.round(inputs.purchasePence / 100)} onChange={setMoney('purchasePence')}
              data-testid="input-purchase"
              className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg" />
          </label>
          <label className="text-sm text-muted">Expected sale price
            <input type="number" inputMode="decimal" min={0} value={Math.round(inputs.salePence / 100)} onChange={setMoney('salePence')}
              data-testid="input-sale"
              className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg" />
          </label>
        </section>

        {/* THE TOGGLE, NOT AN ASSUMPTION. £8,000 in and £10,000 out is £333 on the margin scheme and
            £1,667 if the car is VAT qualifying — four figures apart on one car, so it is asked. */}
        <fieldset className="mt-4" data-testid="vat-toggle">
          <legend className="text-sm text-muted">VAT treatment</legend>
          <div className="mt-1 flex gap-2">
            {([['margin', 'Margin scheme'], ['qualifying', 'VAT qualifying']] as [VatStatus, string][]).map(([v, l]) => (
              <button key={v} type="button" onClick={() => setInputs((p) => ({ ...p, vatStatus: v }))}
                data-testid={`vat-${v}`}
                className={`flex-1 min-h-[44px] rounded-lg border text-sm font-medium ${
                  inputs.vatStatus === v ? 'bg-accent text-white border-accent' : 'bg-surface text-ink border-line'}`}>
                {l}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">
            {inputs.vatStatus === 'margin' ? 'VAT on the margin only, and none if it sells at or below cost.' : 'VAT on the full sale price.'}
          </p>
        </fieldset>

        <section className="mt-6 space-y-5" data-testid="sliders">
          {SLIDERS.map((s) => (
            <div key={s.key}>
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={`s-${s.key}`} className="text-sm font-medium text-ink">{s.label}</label>
                <span className="text-base font-semibold text-ink tabular-nums" data-testid={`value-${s.key}`}>
                  {showSlider(s.key, inputs[s.key])}
                </span>
              </div>
              <input id={`s-${s.key}`} type="range" min={s.min} max={s.max} step={s.step} value={inputs[s.key]}
                onChange={set(s.key)} data-testid={`slider-${s.key}`}
                className="mt-2 w-full h-11 accent-[var(--accent)]" />
              {/* THE RANGE IS PART OF THE HONESTY: a garage that has never measured prep hours does
                  not know whether four is normal, and a bare number implies somebody knows. */}
              <p className="text-xs text-muted">
                {s.note} <span className="whitespace-nowrap">Range {showSlider(s.key, s.min)}–{showSlider(s.key, s.max)}.</span>
              </p>
            </div>
          ))}
        </section>

        {/* WHICH INPUT MOVES THE ANSWER MOST — with the limit attached, because a ranking arrives
            SORTED, which is the shape of a finding, and reads as analysis in a way a slider does not. */}
        <section className="mt-8" data-testid="sensitivity">
          <h2 className="text-sm font-semibold text-ink">What moves this the most</h2>
          <p className="text-xs text-muted" data-testid="sensitivity-limit">
            This ranks <strong>this model’s inputs under these assumptions</strong> — each one swung across its own
            range with the others held where you have them. It is not a claim about your business.
          </p>
          <ol className="mt-2 space-y-1" data-testid="sensitivity-list">
            {ranked.map((x, i) => (
              <li key={x.key} className="flex items-center gap-2 text-sm">
                <span className="w-4 text-muted tabular-nums">{i + 1}</span>
                <span className="flex-1 text-ink">{x.label}</span>
                <span className="text-muted tabular-nums" data-testid={`swing-${x.key}`}>{money(x.swingPence)}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-8 border-t border-line pt-4">
          <h2 className="text-sm font-semibold text-ink">Save this</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="e.g. 57-plate Focus, red"
              data-testid="input-label" className="min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
            <input value={ident} onChange={(e) => setIdent(e.target.value)} maxLength={40} placeholder="Reg or VIN (optional)"
              data-testid="input-ident" className="min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
          </div>
          <button type="button" onClick={save} disabled={busy} data-testid="save"
            className="mt-2 w-full sm:w-auto min-h-[44px] px-5 bg-accent hover:bg-accent-hover text-white text-sm font-semibold rounded-lg disabled:opacity-60">
            {busy ? 'Saving…' : openId ? 'Save changes' : 'Save this model'}
          </button>
          {msg && <p className="mt-2 text-sm text-muted" data-testid="save-message">{msg}</p>}
          {saved && saved.length > 0 && (
            <ul className="mt-4 divide-y divide-line" data-testid="saved-list">
              {saved.map((m) => (
                <li key={m.id} className="py-2 flex items-center gap-3 text-sm">
                  <button type="button" onClick={() => open(m.id)} className="flex-1 text-left min-h-[44px]">
                    <span className="text-ink font-medium">{m.label}</span>
                    {m.vehicle_ident && <span className="text-muted"> · {m.vehicle_ident}</span>}
                    <span className="block text-xs text-muted">
                      {money(m.purchase_pence)} → {money(m.sale_pence)} · {m.vat_status === 'margin' ? 'margin' : 'qualifying'} · modelled profit {money(m.profit_pence)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* THE ANSWER, STICKY ON A PHONE so it stays under the thumb while the sliders move above it. */}
      <div className="fixed bottom-0 inset-x-0 sm:static bg-surface border-t border-line sm:border sm:rounded-xl sm:max-w-3xl sm:mx-auto sm:mb-8 p-3 sm:p-4"
        data-testid="answer">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">Profit</span>
            <span className={`text-2xl font-bold tabular-nums ${r.profitPence < 0 ? 'text-danger' : 'text-ink'}`} data-testid="profit">
              {moneyExact(r.profitPence)}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex justify-between"><dt className="text-muted">VAT</dt><dd className="text-ink tabular-nums" data-testid="out-vat">{moneyExact(r.vatDuePence)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Workshop time</dt><dd className="text-ink tabular-nums" data-testid="out-workshop">{moneyExact(r.workshopCostPence)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Cost of money</dt><dd className="text-ink tabular-nums" data-testid="out-stocking">{moneyExact(r.stockingCostPence)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Other costs</dt><dd className="text-ink tabular-nums" data-testid="out-other">{moneyExact(r.otherCostsPence)}</dd></div>
          </dl>
          {/* THE NUMBER NO GARAGE CALCULATES, said out loud rather than buried in the breakdown. */}
          <p className="mt-2 text-xs text-muted" data-testid="out-uncounted">
            Workshop time and cost of money take {moneyExact(r.workshopCostPence + r.stockingCostPence)} out of this.
            {biggest && <> Biggest lever right now: <strong>{biggest.label}</strong>.</>}
          </p>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n([])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if ('redirect' in gate || 'notFound' in gate) return gate as never;
  return { props: {} };
});
