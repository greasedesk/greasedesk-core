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
  SLIDERS, computeModel, defaultInputs, sensitivity, clampSlider, salesToCoverMonthly,
  SOURCES, SOURCE_RULES, availableVatStatuses, hasFeeSlot,
  FUNDING_KINDS, blankFacility, fundingCost,
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

export default function PurchaseModelPage({ vatRegistered }: { vatRegistered: boolean }) {
  const [inputs, setInputs] = useState<ModelInputs>(defaultInputs);
  // NOT VAT REGISTERED → THE QUALIFYING ROUTE IS NOT OFFERED. Under the threshold there is no
  // recovery and no qualifying sale, so showing the toggle would offer a route they cannot take —
  // and this page's output is a claim about their tax position, which is heavier than a slider.
  const qualifyingAvailable = vatRegistered;
  const [label, setLabel] = useState('');
  const [ident, setIdent] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // PURE, AND RECOMPUTED EVERY RENDER. No effect, no debounce, no stale answer: the model is
  // arithmetic over the inputs, so the screen cannot lag behind the thumb.
  // THE TENANT'S REGISTRATION IS A PROP, NEVER A SAVED FIELD: it is read from the tax profile on every
  // render, so a garage that registers tomorrow gets the right answer on a model saved today.
  const modelOpts = useMemo(() => ({ vatRegistered }), [vatRegistered]);
  const r = useMemo(() => computeModel(inputs, modelOpts), [inputs, modelOpts]);
  const ranked = useMemo(() => sensitivity(inputs, modelOpts), [inputs, modelOpts]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/purchase-model', { cache: 'no-store' });
      if (res.ok) setSaved((await res.json()).models ?? []);
    } catch { /* the tool works offline-ish; the list is the only part that needs the server */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k: SliderKey) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInputs((p) => ({ ...p, [k]: clampSlider(k, Number(e.target.value)) }));
  const setMoney = (k: 'purchasePence' | 'salePence' | 'adContractMonthlyPence' | 'premiumPence' | 'servicesPence') => (e: React.ChangeEvent<HTMLInputElement>) =>
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
  // NULL when there is no contract to cover, and null when the contribution is zero or less: no
  // quantity of a car that loses money covers anything. The page renders a refusal rather than ∞.
  /**
   * THE SAME CAR ON ALL THREE PLANS. Computed through the one fundingCost the answer uses, so the
   * comparison cannot drift from the figure above it — and including the plan currently chosen, because
   * a comparison that hides your own option makes you work out where you already are.
   *
   * The facility row uses the terms AS TYPED. With nothing entered it costs nothing, and the panel says
   * so rather than inventing a rate card to make the row look populated.
   */
  const compare = useMemo(() => {
    const amount = r.vat.cashOutPence + r.fee.cashOutPence;
    const shared = { amountPence: amount, daysInStock: inputs.daysInStock, annualPct: inputs.costOfMoneyAnnualPct };
    const facility = inputs.funding.kind === 'facility' ? inputs.funding : blankFacility();
    return [
      { kind: 'cash' as const, label: 'Own cash', cost: fundingCost({ kind: 'cash' }, shared) },
      { kind: 'overdraft' as const, label: 'Overdraft', cost: fundingCost({ kind: 'overdraft', arrangementFeePence: inputs.funding.kind === 'overdraft' ? inputs.funding.arrangementFeePence : 0 }, shared) },
      { kind: 'facility' as const, label: 'Stocking facility', cost: fundingCost(facility, shared) },
    ];
  }, [r.vat.cashOutPence, r.fee.cashOutPence, inputs.daysInStock, inputs.costOfMoneyAnnualPct, inputs.funding]);

  /**
   * THE ANSWER IS SHOWN TWICE, FROM ONE PLACE. Measured before it was changed: on desktop the panel is
   * `sm:static`, so it sat 2020px down a 2906px page — 1220px below the fold while a slider was under the
   * cursor, which is the whole point of the tool. On a 360x640 phone it was visible but took 214px of the
   * screen, and pb-40 (160px) was less than that, so the foot of the page hid behind it.
   *
   * Two renderings of one number is a divergence waiting to happen, so the figure and the word come from
   * HERE and both places read them — purchase-model-gate asserts the two agree on the served page.
   */
  const answer = { label: 'Contribution', text: moneyExact(r.contributionPence), negative: r.contributionPence < 0 };

  const needed = useMemo(() => salesToCoverMonthly(r.contributionPence, inputs.adContractMonthlyPence),
    [r.contributionPence, inputs.adContractMonthlyPence]);
  return (
    <>
      <Head><title>Buying a car — GreaseDesk</title></Head>
      <div className="max-w-3xl mx-auto px-3 sm:px-6 py-4 pb-8">
        {/* STICKY, ON EVERY VIEWPORT. Not `sm:` only: "visible while a slider is moving" should not depend
            on how wide the screen is, and one behaviour is easier to reason about than two. One line, ~40px,
            so it costs a phone far less than the 214px panel at the foot. */}
        <div className="sticky top-0 z-20 -mx-3 sm:-mx-6 px-3 sm:px-6 py-2 bg-surface border-b border-line flex items-baseline justify-between"
          data-testid="answer-top">
          <span className="text-xs uppercase tracking-wide text-muted">{answer.label}</span>
          <span className={`text-lg font-bold tabular-nums ${answer.negative ? 'text-danger' : 'text-ink'}`}
            data-testid="contribution-top">{answer.text}</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold text-ink">Buying a car</h1>
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

        {/* ── A MONTHLY COST, KEPT OUT OF THE CAR ─────────────────────────────────────────────────
            Deliberately NOT a slider and not inside the per-car section: every slider above is a cost
            this car carries, and putting a fixed overhead among them would invite the division the
            whole design refuses. It changes no figure in the breakdown; it answers one question at the
            bottom of the page. Blank by default — £1,500 is one dealer's quote, not a typical number. */}
        <section className="mt-6 border-t border-line pt-4">
          <label className="text-sm text-muted">Advertising contract, per month
            <input type="number" inputMode="decimal" min={0} value={Math.round(inputs.adContractMonthlyPence / 100) || ''}
              onChange={setMoney('adContractMonthlyPence')} data-testid="input-ad-contract" placeholder="0"
              className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg" />
          </label>
          <p className="mt-1 text-xs text-muted" data-testid="ad-contract-note">
            Autotrader and the rest, as you actually pay for them. This is <strong>not</strong> divided into the car —
            what each car would have to carry depends on how many you sell, which is what you are working out.
          </p>
        </section>

        {/* ── WHERE DID IT COME FROM? ──────────────────────────────────────────────────────────────
            Asked before the VAT treatment because it DECIDES the VAT treatment: a car bought privately
            or taken in part-exchange cannot be VAT qualifying — there is no VAT invoice to reclaim
            against. The toggle used to be free, so "private" plus "qualifying" gave a £1,667 answer
            that cannot happen. And the answer decides what a buyer's fee does: folded into the price
            of the goods at auction, a separate service from a dealer. */}
        <fieldset className="mt-6 border-t border-line pt-4" data-testid="source-question">
          <legend className="text-sm text-muted">Where did you buy it?</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {SOURCES.map((v) => (
              <button key={v} type="button" data-testid={`source-${v}`}
                onClick={() => setInputs((p) => {
                  // THE ANSWER CARRIES ITS CONSEQUENCES. Changing to a source that cannot be qualifying
                  // moves the treatment back to margin HERE, so the screen never shows an impossible
                  // pair even for a render — and the writer enforces the same rule independently.
                  const allowed = availableVatStatuses(v);
                  return {
                    ...p, source: v,
                    vatStatus: allowed.includes(p.vatStatus) ? p.vatStatus : allowed[0],
                    premiumPence: hasFeeSlot(v, 'premium') ? p.premiumPence : 0,
                    servicesPence: hasFeeSlot(v, 'services') ? p.servicesPence : 0,
                  };
                })}
                className={`min-h-[44px] rounded-lg border text-sm font-medium ${
                  inputs.source === v ? 'bg-accent text-white border-accent' : 'bg-surface text-ink border-line'}`}>
                {SOURCE_RULES[v].label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted" data-testid="source-note">{SOURCE_RULES[inputs.source].note}</p>

          {/* ── ONE FIELD PER FEE THE INVOICE ACTUALLY CARRIES ───────────────────────────────────
              Not two amounts of one thing: a premium has its VAT inside it and moves the margin base, an
              indemnity has its VAT shown separately and is reclaimable. The labels are the words the
              invoice uses, because that is what the garage is reading while they type. Absent where the
              source invoices none — an empty box invites a number that means nothing. */}
          {SOURCE_RULES[inputs.source].fees.map((f) => (
            <label key={f.slot} className="mt-3 block text-sm text-muted" data-testid={`fee-field-${f.slot}`}>
              {f.label}
              <input type="number" inputMode="decimal" min={0} step="0.01"
                value={(f.slot === 'premium' ? inputs.premiumPence : inputs.servicesPence) / 100 || ''}
                onChange={setMoney(f.slot === 'premium' ? 'premiumPence' : 'servicesPence')}
                data-testid={`input-${f.slot}`} placeholder="0"
                className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg" />
              <span className="mt-1 block text-xs text-muted" data-testid={`fee-note-${f.slot}`}>{f.note}</span>
            </label>
          ))}

          {/* WHAT THEY ACTUALLY DID, in pounds, because the difference between the two is the point and
              a reader cannot derive it from the figures they typed. One line each, only once typed. */}
          {r.fee.premiumPence > 0 && (
            <p className="mt-2 text-xs text-ink" data-testid="fee-effect-premium">
              The premium is part of the car’s price, so your margin is measured from{' '}
              <strong>{moneyExact(inputs.purchasePence + r.fee.inMarginBasePence)}</strong>
              {inputs.vatStatus === 'margin' && <> — which is {moneyExact(Math.round(r.fee.inMarginBasePence / 6))} less VAT than if it sat outside</>}.
              {' '}Its VAT is already inside it, so there is nothing to reclaim.
            </p>
          )}
          {r.fee.servicesPence > 0 && (
            <p className="mt-1 text-xs text-ink" data-testid="fee-effect-services">
              {SOURCE_RULES[inputs.source].fees.find((f) => f.slot === 'services')?.label} of {moneyExact(r.fee.servicesPence)}
              {' '}plus {moneyExact(r.fee.servicesVatPence)} VAT — {moneyExact(r.fee.servicesPence + r.fee.servicesVatPence)} out of the bank,
              {r.fee.reclaimablePence > 0
                ? <> {moneyExact(r.fee.reclaimablePence)} of it back on your next return,</>
                : <> none of it reclaimable while you are not registered,</>}
              {' '}and none of it in your margin.
            </p>
          )}
        </fieldset>

        {/* ── HOW IS IT PAID FOR? THREE SHAPES, NOT ONE RATE ───────────────────────────────────────
            The cost-of-money slider is an annual percentage. A stocking facility is not: it CURTAILS —
            takes a slice of the advance back every month whether or not the car has sold — which is a
            repayment schedule. Treating it as a rate gets the interest wrong (the balance declines) and
            the cash badly wrong (money must be found before the sale). */}
        <fieldset className="mt-6 border-t border-line pt-4" data-testid="funding-question">
          <legend className="text-sm text-muted">How are you paying for it?</legend>
          <div className="mt-1 flex gap-2">
            {FUNDING_KINDS.map((k) => (
              <button key={k} type="button" data-testid={`funding-${k}`}
                onClick={() => setInputs((p) => ({
                  ...p,
                  // A FACILITY STARTS BLANK, never with somebody's rate card in it.
                  funding: k === 'cash' ? { kind: 'cash' }
                    : k === 'overdraft' ? { kind: 'overdraft', arrangementFeePence: 0 }
                    : blankFacility(),
                }))}
                className={`flex-1 min-h-[44px] rounded-lg border text-sm font-medium ${
                  inputs.funding.kind === k ? 'bg-accent text-white border-accent' : 'bg-surface text-ink border-line'}`}>
                {k === 'cash' ? 'Own cash' : k === 'overdraft' ? 'Overdraft' : 'Stocking facility'}
              </button>
            ))}
          </div>

          {inputs.funding.kind === 'overdraft' && (
            <label className="mt-3 block text-sm text-muted" data-testid="overdraft-fee-field">Arrangement fee
              <input type="number" inputMode="decimal" min={0} value={Math.round(inputs.funding.arrangementFeePence / 100) || ''}
                onChange={(e) => setInputs((p) => ({ ...p, funding: { kind: 'overdraft', arrangementFeePence: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) } }))}
                data-testid="input-overdraft-fee" placeholder="0"
                className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg" />
            </label>
          )}

          {inputs.funding.kind === 'facility' && (
            <div className="mt-3" data-testid="facility-terms">
              {/* BLANK, AND IT SAYS WHY. "Roughly 10% a month" describes one product; a default is the
                  strongest claim an interface can make, and this one is not ours to make. */}
              <p className="text-xs text-muted" data-testid="facility-read-your-agreement">
                These come from your own agreement — read it rather than guessing. Nothing is filled in for you.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {([
                  ['advancePct', 'Advance, % of price', '%'],
                  ['monthlyPctOfAdvance', 'Charge, % a month', '%'],
                  ['curtailPctPerMonth', 'Curtailment, % a month', '%'],
                  ['graceDays', 'Grace, days', 'd'],
                  ['termDays', 'Term, days', 'd'],
                ] as [keyof Extract<ModelInputs['funding'], { kind: 'facility' }>, string, string][]).map(([k, label]) => (
                  <label key={String(k)} className="text-xs text-muted">{label}
                    <input type="number" inputMode="decimal" min={0}
                      value={(inputs.funding as Extract<ModelInputs['funding'], { kind: 'facility' }>)[k] as number || ''}
                      onChange={(e) => setInputs((p) => ({ ...p, funding: { ...(p.funding as Extract<ModelInputs['funding'], { kind: 'facility' }>), [k]: Math.max(0, Number(e.target.value || 0)) } }))}
                      data-testid={`input-facility-${String(k)}`} placeholder="0"
                      className="mt-1 w-full min-h-[40px] p-2 bg-surface border border-line rounded-lg text-ink" />
                  </label>
                ))}
                <label className="text-xs text-muted">Fee per car
                  <input type="number" inputMode="decimal" min={0}
                    value={Math.round((inputs.funding as Extract<ModelInputs['funding'], { kind: 'facility' }>).perUnitFeePence / 100) || ''}
                    onChange={(e) => setInputs((p) => ({ ...p, funding: { ...(p.funding as Extract<ModelInputs['funding'], { kind: 'facility' }>), perUnitFeePence: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) } }))}
                    data-testid="input-facility-perUnitFeePence" placeholder="0"
                    className="mt-1 w-full min-h-[40px] p-2 bg-surface border border-line rounded-lg text-ink" />
                </label>
              </div>
              {/* A REFUSAL, NOT A COST. The facility does not quietly charge more for day 150 of a
                  120-day term — it demands the balance. */}
              {r.funding.overTerm === true && (
                <p className="mt-2 text-xs text-danger" data-testid="over-term">
                  {inputs.daysInStock} days is longer than your {(inputs.funding as Extract<ModelInputs['funding'], { kind: 'facility' }>).termDays}-day term.
                  The balance falls due before the car sells — this is not a cost to add, it is a plan that does not work.
                </p>
              )}
            </div>
          )}
        </fieldset>

        {/* THE TOGGLE, NOT AN ASSUMPTION. £8,000 in and £10,000 out is £333 on the margin scheme and
            £1,667 if the car is VAT qualifying — four figures apart on one car, so it is asked. */}
        {qualifyingAvailable ? (
          <fieldset className="mt-4" data-testid="vat-toggle">
            <legend className="text-sm text-muted">VAT treatment</legend>
            <div className="mt-1 flex gap-2">
              {([['margin', 'Margin scheme'], ['qualifying', 'VAT qualifying']] as [VatStatus, string][])
                // ONLY WHAT THIS SOURCE CAN PRODUCE. Filtered rather than disabled: a greyed-out
                // control invites "why not?", and the source note above already answers it.
                .filter(([v]) => availableVatStatuses(inputs.source).includes(v))
                .map(([v, l]) => (
                <button key={v} type="button" onClick={() => setInputs((p) => ({ ...p, vatStatus: v }))}
                  data-testid={`vat-${v}`}
                  className={`flex-1 min-h-[44px] rounded-lg border text-sm font-medium ${
                    inputs.vatStatus === v ? 'bg-accent text-white border-accent' : 'bg-surface text-ink border-line'}`}>
                  {l}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">
              {inputs.vatStatus === 'margin' ? 'VAT on the margin only, and none if it sells at or below cost.' : 'VAT on the full sale price, less the VAT you reclaim on the purchase.'}
            </p>
            {availableVatStatuses(inputs.source).length === 1 && (
              <p className="mt-1 text-xs text-muted" data-testid="vat-forced">
                {SOURCE_RULES[inputs.source].label} means there is no VAT invoice to reclaim against, so the margin scheme is the only route.
              </p>
            )}

            {/* THE QUESTION THE WHOLE DEFECT CAME FROM. Asked as the invoice in front of them, not as
                tax, and only where it means anything. Neither reading announced itself before. */}
            {inputs.vatStatus === 'qualifying' && (
              <div className="mt-3" data-testid="inc-vat-question">
                <span className="text-sm text-muted">Is that purchase price…</span>
                <div className="mt-1 flex gap-2">
                  {([[false, 'Plus VAT'], [true, 'Includes VAT']] as [boolean, string][]).map(([v, l]) => (
                    <button key={String(v)} type="button" onClick={() => setInputs((p) => ({ ...p, purchaseIncludesVat: v }))}
                      data-testid={`incvat-${v ? 'inc' : 'plus'}`}
                      className={`flex-1 min-h-[44px] rounded-lg border text-sm font-medium ${
                        inputs.purchaseIncludesVat === v ? 'bg-accent text-white border-accent' : 'bg-surface text-ink border-line'}`}>
                      {l}
                    </button>
                  ))}
                </div>
                {/* SAY WHICH ANSWER IS IN FORCE. The defect was that neither reading announced itself. */}
                <p className="mt-1 text-xs text-ink" data-testid="inc-vat-inforce">
                  {inputs.purchaseIncludesVat
                    ? `Taking ${money(inputs.purchasePence)} as the total paid, with ${money(r.vat.inputVatPence)} of VAT inside it to reclaim.`
                    : `Taking ${money(inputs.purchasePence)} as the price before VAT — so ${money(r.vat.cashOutPence)} leaves the bank and ${money(r.vat.inputVatPence)} comes back.`}
                </p>
                {/* NAMED, NOT MODELLED. */}
                <p className="mt-1 text-xs text-muted" data-testid="reclaim-timing">
                  The reclaim arrives on your next VAT return, so that money can be out for up to about four months.
                </p>
                <p className="mt-1 text-xs text-muted" data-testid="stock-assumption">
                  This assumes the car is stock for resale.
                </p>
              </div>
            )}
          </fieldset>
        ) : (
          <p className="mt-4 text-sm text-muted" data-testid="not-vat-registered">
            You are not VAT registered, so this uses the margin scheme. There is no VAT to reclaim on a purchase.
          </p>
        )}

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
          {/* ── THE NUMBER MUST SAY WHAT IT IS ────────────────────────────────────────────────────
              These are SWINGS — how far contribution moves when an input is dragged across its whole range
              — and they sat right-aligned in the same column as nine slider VALUES, formatted
              identically. The owner read £2,000 here against £800 on the Parts slider and called it a
              mismatch; if the person who specified the feature misreads it, the header was never
              going to be enough. So the column is titled, and every figure carries ± and the word.  */}
          <div className="mt-3 flex items-baseline gap-2 text-[11px] uppercase tracking-wide text-muted border-b border-line pb-1"
            data-testid="sensitivity-heading">
            <span className="w-4" />
            <span className="flex-1">Input</span>
            <span>Moves contribution by</span>
          </div>
          <ol className="mt-1 space-y-1" data-testid="sensitivity-list">
            {ranked.map((x, i) => (
              <li key={x.key} className="flex items-center gap-2 text-sm">
                <span className="w-4 text-muted tabular-nums">{i + 1}</span>
                <span className="flex-1 text-ink">{x.label}</span>
                <span className="text-muted tabular-nums whitespace-nowrap" data-testid={`swing-${x.key}`}>
                  ±{money(x.swingPence)} <span className="text-[11px]">swing</span>
                </span>
              </li>
            ))}
          </ol>
          {/* SAID OUT LOUD, because the biggest lever on a facility-funded car may be the FACILITY, and
              a ranking that silently omits it would be the same kind of lie as a swing read as a cost.
              A plan is a choice between shapes, not a number with a range, so it cannot be swung —
              it is compared instead, below. */}
          <p className="mt-2 text-xs text-muted" data-testid="sensitivity-scope">
            This ranks the sliders only. How you pay for the car is a choice, not a range — compare the three below.
          </p>
          {/* ── THE THREE SHAPES, SIDE BY SIDE ────────────────────────────────────────────────────
              Two columns, because the two questions are different: what the money COSTS, and what it
              DEMANDS before the car sells. A facility can be cheaper than an overdraft and still be the
              plan that empties the bank in October. */}
          <div className="mt-4 border-t border-line pt-3" data-testid="funding-compare">
            <div className="flex items-baseline gap-2 text-[11px] uppercase tracking-wide text-muted border-b border-line pb-1">
              <span className="flex-1">Paying for it</span>
              <span className="w-24 text-right">Costs</span>
              <span className="w-32 text-right">Wants back first</span>
            </div>
            {compare.map((c) => (
              <div key={c.kind} className={`flex items-center gap-2 text-sm py-1 ${inputs.funding.kind === c.kind ? 'text-ink font-medium' : 'text-muted'}`}
                data-testid={`compare-${c.kind}`}>
                <span className="flex-1">{c.label}{inputs.funding.kind === c.kind ? ' — yours' : ''}</span>
                <span className="w-24 text-right tabular-nums" data-testid={`compare-cost-${c.kind}`}>{money(c.cost.totalPence)}</span>
                <span className="w-32 text-right tabular-nums" data-testid={`compare-before-${c.kind}`}>
                  {c.cost.cashBeforeSalePence > 0 ? money(c.cost.cashBeforeSalePence) : '—'}
                </span>
              </div>
            ))}
            {inputs.funding.kind !== 'facility' && compare[2].cost.totalPence === 0 && (
              <p className="mt-1 text-xs text-muted" data-testid="facility-unfilled">
                The facility row is empty because its terms are not entered — choose Stocking facility above and put your own agreement in.
              </p>
            )}
          </div>
          <p className="mt-2 text-xs text-muted" data-testid="sensitivity-not-cost">
            These are not costs. A swing is the difference in contribution between that slider at its lowest and its highest.
          </p>
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

      {/* ── THE BREAKDOWN SITS IN THE FLOW, ON EVERY VIEWPORT ────────────────────────────────────
          It used to be `fixed bottom-0` on a phone so the figure stayed under the thumb. The sticky line
          at the TOP does that job now, and the overlay was costing more than it gave:

            · 214px of a 640px screen, a third of it, permanently;
            · the foot of the page hid underneath — "Save this model" sat 54px behind it, visible and
              unreachable — and the clearance was a FIXED padding against a panel whose height CHANGES
              with state. Raising pb-40 to pb-56 fixed the default case and broke again the moment a
              stocking facility added two lines to the panel (measured: −13px). A constant cannot
              reserve space for a variable.

          Static, so the overlap cannot exist. The number a person watches while dragging is at the top;
          the breakdown is below, where reading it covers nothing. */}
      <div className="bg-surface border border-line rounded-xl max-w-3xl mx-auto mb-8 p-3 sm:p-4"
        data-testid="answer">
        <div className="max-w-3xl mx-auto">
          {/* CONTRIBUTION, NOT PROFIT. This counts what the CAR costs and nothing the business pays
              whether the car exists or not — the advertising contract, rent, insurance. A figure that
              excludes every fixed cost is a contribution, and "Profit" in 24px bold invited the exact
              misreading the swing column was fixed for the day before. */}
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">{answer.label}</span>
            <span className={`text-2xl font-bold tabular-nums ${answer.negative ? 'text-danger' : 'text-ink'}`} data-testid="contribution">
              {answer.text}
            </span>
          </div>
          <p className="text-[11px] text-muted" data-testid="contribution-means">
            What this car adds before your fixed monthly costs — not profit.
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex justify-between"><dt className="text-muted">VAT</dt><dd className="text-ink tabular-nums" data-testid="out-vat">{moneyExact(r.vatDuePence)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Workshop time</dt><dd className="text-ink tabular-nums" data-testid="out-workshop">{moneyExact(r.workshopCostPence)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Cost of money</dt><dd className="text-ink tabular-nums" data-testid="out-stocking">{moneyExact(r.stockingCostPence)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Other costs</dt><dd className="text-ink tabular-nums" data-testid="out-other">{moneyExact(r.otherCostsPence)}</dd></div>
          </dl>
          {/* CASH OUT IS NOT COST. On a plus-VAT purchase the bank loses 20% more than the car costs,
              and the cost of money is charged on THAT — a tool about tied-up capital that charged
              interest on the smaller number would be wrong about its own subject. */}
          <p className="mt-2 text-xs text-muted" data-testid="out-cash">
            Cash out to buy it: <strong className="text-ink">{moneyExact(r.vat.cashOutPence)}</strong>
            {r.vat.inputVatPence > 0 && <> — including {moneyExact(r.vat.inputVatPence)} of VAT you reclaim later.</>}
            {' '}The cost of money is charged on that.
          </p>
          {/* THE NUMBER AN ANNUAL PERCENTAGE CANNOT EXPRESS, beside cash out because it is the same
              question: how much money is this car actually taking out of the bank, and when. */}
          {r.funding.cashBeforeSalePence > 0 && (
            <p className="mt-1 text-xs text-ink" data-testid="cash-before-sale">
              And <strong>{moneyExact(r.funding.cashBeforeSalePence)}</strong> of that must be repaid before the car sells —
              {' '}{r.funding.schedule.length} {r.funding.schedule.length === 1 ? 'payment' : 'payments'} falling due while you still have it.
            </p>
          )}
          {/* ── THE FIXED COST, AS A QUESTION THIS PAGE CAN ANSWER ──────────────────────────────
              Autotrader is a monthly contract: about £1,500 for ten cars, £5,000+ for a bigger
              dealer. Dividing it gives £150 a car at ten sales and £300 at five, so a per-car
              advertising figure asks for a number that depends on turnover — which is partly what
              this model exists to work out. The denominator is exactly what the page cannot know.
              So nothing is divided. The contract drives ONE sentence, in the honest direction. */}
          {needed !== null ? (
            <p className="mt-2 text-xs text-muted" data-testid="break-even">
              {/* Phrased to put the contract first so the sentence needs no verb agreement with a
                  number that changes: "2 sales a month covers" was wrong and "cover" reads oddly at 1. */}
              At this contribution, your {money(inputs.adContractMonthlyPence)} advertising contract
              needs <strong className="text-ink">{needed} {needed === 1 ? 'sale' : 'sales'} a month</strong>.
            </p>
          ) : inputs.adContractMonthlyPence > 0 ? (
            <p className="mt-2 text-xs text-danger" data-testid="break-even-impossible">
              No number of sales covers your {money(inputs.adContractMonthlyPence)} advertising contract at this contribution.
            </p>
          ) : null}
          {/* THE NUMBER NO GARAGE CALCULATES, said out loud rather than buried in the breakdown. */}
          <p className="mt-2 text-xs text-muted" data-testid="out-uncounted">
            Workshop time and cost of money take {moneyExact(r.workshopCostPence + r.stockingCostPence)} out of this.
            {biggest && <> Biggest lever right now: <strong>{biggest.label}</strong> — dragging it across its range moves contribution by {moneyExact(biggest.swingPence)}.</>}
          </p>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n([])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  // THE TENANT'S OWN REGISTRATION, from the tax chokepoint. NOT garageVatRegistered(), which is
  // GreaseDesk Ltd's own VAT status for its own pricing and says nothing about the garage — a
  // mistake worth naming, because the two read alike and only one of them is about this tenant.
  const { getTaxProfile } = await import('@/lib/tenant-vat');
  const profile = await getTaxProfile(gate.vis.groupId as string).catch(() => null);
  // FAILS TOWARDS THE SIMPLER TOOL: if the profile cannot be read, offer the margin scheme only.
  // Offering a reclaim to a garage that cannot make one is the expensive direction.
  return { props: { vatRegistered: profile?.isRegistered === true } };
});
