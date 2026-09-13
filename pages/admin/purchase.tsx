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
  GROSS_BASIS_NOTE, SALE_BASIS_NOTE, FLAGGED_COSTS, VAT_TREATMENTS,
  perSlotMonthlyPence, slotUtilisation,
  type AdvertisingPackage, type FlaggedCost, type VatTreatment,
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

export default function PurchaseModelPage(
  { vatRegistered, costVatDefaults, advertisingPackage }:
  { vatRegistered: boolean; costVatDefaults: Record<FlaggedCost, VatTreatment>; advertisingPackage: AdvertisingPackage },
) {
  // SEEDED FROM THE TENANT, then owned by the model. Changing a standing answer must not rewrite a
  // saved car's result, so this is the starting value and nothing reads it again.
  const [inputs, setInputs] = useState<ModelInputs>(() => ({
    ...defaultInputs(),
    costVat: costVatDefaults,
    // SEEDED, NOT READ. The per-slot figure is captured into the model when it is created, so changing
    // the package later cannot rewrite what this car was modelled to cost.
    slotCostPerMonthPence: perSlotMonthlyPence(advertisingPackage) ?? 0,
  }));
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
  const setMoney = (k: 'purchasePence' | 'salePence' | 'premiumPence' | 'servicesPence') => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInputs((p) => ({ ...p, [k]: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) }));

  /**
   * REMEMBER THESE, and say so. A control that silently succeeds teaches nobody that it did anything —
   * and this one writes a tenant-wide fact from a page about one car, which is exactly the kind of
   * write that should announce itself.
   */
  const [supplierMsg, setSupplierMsg] = useState<string | null>(null);
  const [packageMsg, setPackageMsg] = useState<string | null>(null);
  // THE PACKAGE IS THE TENANT'S, held here so it can be edited and saved from this page. What SEEDS the
  // model is the derived per-slot figure below — the package itself never reaches computeModel.
  const [pkg, setPkg] = useState<AdvertisingPackage>(advertisingPackage);

  /**
   * EDITING THE PACKAGE RE-SEEDS THE CAR IN FRONT OF YOU, and that is not "reading it live".
   *
   * The rule is that a saved model keeps the slot cost it was built with, so renegotiating the contract
   * next month cannot rewrite it. But a person typing their package here, now, is SAYING what a slot
   * costs — and leaving the car on screen at £0 until they reload would be obeying the letter of the
   * rule against its purpose. So an explicit edit re-seeds; nothing else ever does.
   */
  const editPackage = (patch: Partial<AdvertisingPackage>) => setPkg((q) => {
    const next = { ...q, ...patch };
    setInputs((prev) => ({ ...prev, slotCostPerMonthPence: perSlotMonthlyPence(next) ?? 0 }));
    return next;
  });
  const perSlot = useMemo(() => perSlotMonthlyPence(pkg), [pkg]);
  const util = useMemo(() => slotUtilisation(pkg), [pkg]);

  async function rememberPackage() {
    setBusy(true); setPackageMsg(null);
    try {
      const res = await fetch('/api/purchase-model-defaults', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ advertising: pkg }),
      });
      setPackageMsg(res.ok ? 'Saved.' : 'Could not save that.');
    } catch {
      setPackageMsg('Could not save that.');
    } finally {
      setBusy(false);
    }
  }
  async function rememberSuppliers() {
    setBusy(true); setSupplierMsg(null);
    try {
      const res = await fetch('/api/purchase-model-defaults', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costVat: inputs.costVat }),
      });
      setSupplierMsg(res.ok ? 'Saved for every new model.' : 'Could not save those.');
    } catch {
      setSupplierMsg('Could not save those.');
    } finally {
      setBusy(false);   // BUSY CLEARED IN finally, per the standing rule — a same-URL refresh never remounts.
    }
  }

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
  // NULL when there is no contract to cover, and null when the gross profit is zero or less: no
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
  const answer = {
    label: 'Gross profit on this car',
    // BOTH EXCLUSIONS NAMED. Fixed monthly costs and tax are the two this model does not count, and
    // saying both is what makes the qualified label honest — "gross" alone tells a reader nothing about
    // which costs are missing. Neither is claimed to be the only one.
    subtitle: 'Before your fixed monthly costs and tax.',
    text: moneyExact(r.grossProfitPence),
    negative: r.grossProfitPence < 0,
  };

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
            data-testid="gross-profit-top">{answer.text}</span>
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
          {/* ── THE FIGURE THAT NEVER SAID WHAT IT WAS ─────────────────────────────────────────────
              `outputVat = sale × 1/6` EXTRACTS VAT from a VAT-inclusive amount, so this field has been
              gross by construction since the qualifying toggle shipped — and the label said nothing at
              all. Type an ex-VAT sale price on a qualifying car and the VAT owed is understated by a
              sixth OF THE WHOLE SALE: £1,667 on a £10,000 car, an order of magnitude past any slider. */}
          <label className="text-sm text-muted">Expected sale price
            <input type="number" inputMode="decimal" min={0} value={Math.round(inputs.salePence / 100)} onChange={setMoney('salePence')}
              data-testid="input-sale"
              className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink text-lg" />
            <span className="mt-1 block text-xs text-muted" data-testid="sale-basis">{SALE_BASIS_NOTE}</span>
          </label>
        </section>

        {/* ── HOW YOUR SUPPLIERS CHARGE YOU ────────────────────────────────────────────────────────
            ONE PLACE, not a control bolted to each slider. Five three-state selectors scattered through
            the sliders would triple the height of the section a person is dragging, for answers that
            change once a year. Here they sit together, which is also how a garage thinks about them:
            "my paint shop isn't registered, my parts factor is".

            THE THIRD STATE EARNS ITS PLACE even though it costs the same as the second. "No VAT" is
            what an unregistered supplier does; "not recoverable" is VAT we pay and cannot have back.
            Same arithmetic, different fact, and only one of them is true of the recovery man. */}
        <section className="mt-6 border-t border-line pt-4" data-testid="supplier-vat">
          <h2 className="text-sm text-muted">How your suppliers charge you</h2>
          <p className="mt-1 text-xs text-muted" data-testid="supplier-vat-note">
            Every cost above is what leaves the bank. Whether the VAT inside it comes back depends on who invoiced you —
            a recovery man who is not VAT registered charges none at all.
          </p>
          <div className="mt-2 space-y-2">
            {FLAGGED_COSTS.map((key) => {
              const slider = SLIDERS.find((s) => s.key === key)!;
              return (
                <div key={key} className="flex items-center gap-2 text-sm" data-testid={`supplier-row-${key}`}>
                  <span className="flex-1 text-ink">{slider.label}</span>
                  <select value={inputs.costVat[key]} data-testid={`supplier-vat-${key}`}
                    onChange={(e) => setInputs((prev) => ({
                      ...prev, costVat: { ...prev.costVat, [key]: e.target.value as VatTreatment },
                    }))}
                    className="min-h-[40px] rounded-lg border border-line bg-surface px-2 text-ink text-sm">
                    {VAT_TREATMENTS.map((v) => (
                      <option key={v} value={v}>
                        {v === 'standard_recoverable' ? 'VAT, and I claim it back'
                          : v === 'standard_not_recoverable' ? 'VAT, but I cannot claim it'
                          : 'No VAT charged'}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          {/* WHAT IT IS WORTH, so the answer is not an abstraction. Only once something is recoverable. */}
          {r.costVatReclaimablePence > 0 && (
            <p className="mt-2 text-xs text-ink" data-testid="cost-vat-reclaim">
              {moneyExact(r.costCashPence)} of costs leaves the bank and {moneyExact(r.costVatReclaimablePence)} of VAT
              comes back on your next return, so they cost you {moneyExact(r.costCashPence - r.costVatReclaimablePence)}.
            </p>
          )}
          {!vatRegistered && (
            <p className="mt-2 text-xs text-muted" data-testid="not-registered-no-reclaim">
              You are not VAT registered, so nothing is reclaimable whatever a supplier charges — these answers change no figure until you are.
            </p>
          )}
          <button type="button" onClick={rememberSuppliers} disabled={busy}
            data-testid="remember-suppliers"
            className="mt-3 min-h-[40px] rounded-lg border border-line px-3 text-sm text-ink disabled:opacity-50">
            Remember these for next time
          </button>
          {supplierMsg && <span className="ml-2 text-xs text-muted" data-testid="remember-suppliers-msg">{supplierMsg}</span>}
        </section>

        {/* ── THE ADVERTISING PACKAGE: SLOTS, NOT A LUMP SUM ──────────────────────────────────────
            Autotrader is X slots at £Y a month, so the per-car cost has a KNOWN denominator and is
            DERIVED here rather than typed on every model. A car occupies its slot while it is in stock,
            which makes this a days-in-stock cost — the same driver as the money.

            TENANT LEVEL, and seeded into each model rather than read by the arithmetic: renegotiating
            the contract must not rewrite the answer on every car already modelled. */}
        <section className="mt-6 border-t border-line pt-4" data-testid="ad-package">
          <h2 className="text-sm text-muted">Your advertising package</h2>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <label className="text-xs text-muted">Per month
              <input type="number" inputMode="decimal" min={0} value={Math.round(pkg.monthlyPence / 100) || ''}
                onChange={(e) => editPackage({ monthlyPence: Math.max(0, Math.round(Number(e.target.value || 0) * 100)) })}
                data-testid="input-package-monthly" placeholder="0"
                className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
            </label>
            <label className="text-xs text-muted">Slots
              <input type="number" inputMode="numeric" min={0} value={pkg.slots || ''}
                onChange={(e) => editPackage({ slots: Math.max(0, Math.round(Number(e.target.value || 0))) })}
                data-testid="input-package-slots" placeholder="0"
                className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
            </label>
            <label className="text-xs text-muted">Cars in stock
              <input type="number" inputMode="numeric" min={0} value={pkg.carsInStock || ''}
                onChange={(e) => editPackage({ carsInStock: Math.max(0, Math.round(Number(e.target.value || 0))) })}
                data-testid="input-package-stock" placeholder="0"
                className="mt-1 w-full min-h-[44px] p-2 bg-surface border border-line rounded-lg text-ink" />
            </label>
          </div>
          <p className="mt-1 text-xs text-muted" data-testid="ad-package-note">
            {GROSS_BASIS_NOTE} The per-slot cost is worked out from the first two — it is not typed, so it cannot disagree with your contract.
          </p>
          {perSlot != null ? (
            <p className="mt-2 text-xs text-ink" data-testid="per-slot">
              <strong>{moneyExact(perSlot)}</strong> per slot per month, charged to a car for as long as it is in stock.
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted" data-testid="per-slot-unknown">
              Tell us the monthly cost and the slot count and every car carries its share. Until then, no advertising cost is charged at all.
            </p>
          )}

          {/* ── SLOT UTILISATION, WHICH REPLACED THE BREAK-EVEN SENTENCE ───────────────────────────
              "How many sales cover the contract?" was the honest question while the contract looked
              like a lump sum with no denominator. It states its slot count, so the cost is fully
              allocated and there is no unallocated overhead left to cover. The live question is
              whether the slots are occupied, and nobody is asking it. */}
          {util && (util.emptySlots > 0 || util.unadvertisedCars > 0) && (
            <p className={`mt-2 text-xs ${util.emptySlots > 0 ? 'text-danger' : 'text-muted'}`} data-testid="slot-utilisation">
              {util.emptySlots > 0
                ? <>You are paying for {util.slots} slots and filling {util.carsInStock}. {util.emptySlots} empty {util.emptySlots === 1 ? 'slot costs' : 'slots cost'} you <strong>{moneyExact(util.wastedMonthlyPence)} a month</strong>.</>
                : <>You have {util.carsInStock} cars and {util.slots} slots — {util.unadvertisedCars} of them {util.unadvertisedCars === 1 ? 'is' : 'are'} not advertised.</>}
            </p>
          )}
          {util && util.emptySlots === 0 && util.unadvertisedCars === 0 && (
            <p className="mt-2 text-xs text-muted" data-testid="slot-utilisation-full">
              All {util.slots} slots filled.
            </p>
          )}

          <button type="button" onClick={rememberPackage} disabled={busy}
            data-testid="remember-package"
            className="mt-3 min-h-[40px] rounded-lg border border-line px-3 text-sm text-ink disabled:opacity-50">
            Save my package
          </button>
          {packageMsg && <span className="ml-2 text-xs text-muted" data-testid="remember-package-msg">{packageMsg}</span>}

          {/* WHAT IS NOT MODELLED, said where it would otherwise be assumed. */}
          <p className="mt-2 text-[11px] text-muted" data-testid="package-unanswered">
            Not yet modelled: part-exchange slots for cheap cars, and whether your months run from the 1st or from
            the day a car is listed. Both change the figures, so neither is guessed.
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
                {/* THE BASIS COMES FROM THE SLIDER'S OWN DECLARATION, not from a note somebody remembered
                    to write — so a money slider cannot be added later without saying which figure it wants. */}
                {s.basis === 'gross' && (
                  <span className="block text-ink" data-testid={`basis-${s.key}`}>{GROSS_BASIS_NOTE}</span>
                )}
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
              These are SWINGS — how far gross profit moves when an input is dragged across its whole range
              — and they sat right-aligned in the same column as nine slider VALUES, formatted
              identically. The owner read £2,000 here against £800 on the Parts slider and called it a
              mismatch; if the person who specified the feature misreads it, the header was never
              going to be enough. So the column is titled, and every figure carries ± and the word.  */}
          <div className="mt-3 flex items-baseline gap-2 text-[11px] uppercase tracking-wide text-muted border-b border-line pb-1"
            data-testid="sensitivity-heading">
            <span className="w-4" />
            <span className="flex-1">Input</span>
            <span>Moves gross profit by</span>
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
            These are not costs. A swing is the difference in gross profit between that slider at its lowest and its highest.
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
          {/* GROSS PROFIT ON THIS CAR — qualified, not avoided. This counts what the CAR costs and
              nothing the business pays whether the car exists or not (the Autotrader subscription, rent,
              insurance), and no tax. The BARE word "Profit" in 24px bold was the defect: it read as the
              bottom line. "Gross profit on this car" says which profit, and the subtitle names both
              exclusions underneath. */}
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted">{answer.label}</span>
            <span className={`text-2xl font-bold tabular-nums ${answer.negative ? 'text-danger' : 'text-ink'}`} data-testid="gross-profit">
              {answer.text}
            </span>
          </div>
          <p className="text-[11px] text-muted" data-testid="gross-profit-means">{answer.subtitle}</p>
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
          {/* ── THE SLOT, AND THE BOUNDARY THAT MUST NOT READ AS A BUG ────────────────────────────
              Charged in whole months because the contract says "or part thereof". That makes the cost a
              STEP where every other cost on this page is smooth — 30 days £100, 31 days £200 — so the
              step is explained rather than left to look broken. The boundary is also the most actionable
              number in the model: it is the one thing a dealer can act on this week.

              The break-even sentence stood here until the slot count arrived. It asked how many sales
              would cover the contract, which was the honest question while the contract looked like a
              lump sum with no denominator. It has one, so the cost is fully allocated per car and there
              is no unallocated overhead left to cover. Utilisation asks the live question instead. */}
          {inputs.slotCostPerMonthPence > 0 && r.slot.monthsCharged > 0 && (
            <p className="mt-2 text-xs text-ink" data-testid="slot-charge">
              Advertising: {r.slot.monthsCharged} {r.slot.monthsCharged === 1 ? 'month' : 'months'} of a slot
              at {moneyExact(inputs.slotCostPerMonthPence)} — {moneyExact(r.slot.cashPence)}.
              {r.slot.daysBeforeNextCharge === 0
                ? <> <strong>One more day starts another month</strong> and costs {moneyExact(r.slot.nextChargePence)}.</>
                : <> Covered for {r.slot.daysBeforeNextCharge} more {r.slot.daysBeforeNextCharge === 1 ? 'day' : 'days'};
                    after that it is another {moneyExact(r.slot.nextChargePence)}.</>}
            </p>
          )}
          {/* THE NUMBER NO GARAGE CALCULATES, said out loud rather than buried in the breakdown. */}
          <p className="mt-2 text-xs text-muted" data-testid="out-uncounted">
            Workshop time and cost of money take {moneyExact(r.workshopCostPence + r.stockingCostPence)} out of this.
            {biggest && <> Biggest lever right now: <strong>{biggest.label}</strong> — dragging it across its range moves gross profit by {moneyExact(biggest.swingPence)}.</>}
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
  // THE GARAGE'S STANDING ANSWERS about its suppliers, which SEED a new model and are never read by
  // the arithmetic. Defaults if it has never said — and the defaults are today's behaviour exactly.
  const { getCostVatDefaults } = await import('@/lib/purchase-model-defaults');
  const costVatDefaults = await getCostVatDefaults(gate.vis.groupId as string).catch(() => null);
  const { getAdvertisingPackage } = await import('@/lib/purchase-model-defaults');
  const advertisingPackage = await getAdvertisingPackage(gate.vis.groupId as string).catch(() => null);
  const { defaultCostVat, emptyAdvertisingPackage } = await import('@/lib/purchase-model');
  return {
    props: {
      vatRegistered: profile?.isRegistered === true,
      // BOTH FAIL TOWARDS TODAY'S ARITHMETIC, like the line above fails towards the simpler tool: the
      // defaults charge every cost at face value, and an undescribed package charges no slot at all.
      costVatDefaults: costVatDefaults ?? defaultCostVat(),
      advertisingPackage: advertisingPackage ?? emptyAdvertisingPackage(),
    },
  };
});
