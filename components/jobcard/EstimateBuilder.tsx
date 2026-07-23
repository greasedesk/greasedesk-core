/**
 * File: components/jobcard/EstimateBuilder.tsx
 * Staff-side quote/estimate builder. Labour + parts line tables, per-line VAT toggle, editable
 * per-quote VAT rate, negative prices allowed (discount lines). Live totals come from the shared
 * pure chokepoint lib/quote-totals.ts (same maths the API persists); money via formatMoney.
 * Mobile-first: each line is a stacked touch card on a phone, an aligned row at sm+.
 * Read-only when the viewer can't edit pricing (STANDARD).
 *
 * Note: LineRow is defined at MODULE SCOPE (not inside the component) and rows are keyed by a
 * stable per-line _uid — otherwise React remounts each input every keystroke and focus is lost.
 */
import React, { useMemo, useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'next-i18next';
import { computeQuoteTotals, poundsToPennies, QuoteItemType } from '@/lib/quote-totals';
import { resolveTierPrice, fixedLineText } from '@/lib/catalogue';
import { PromoLite, computePromoDiscounts } from '@/lib/promo';
import { formatMoney } from '@/lib/format-money';
// THE SHARED SHAPE (sections, row card, code autocomplete). Layout only — the fields below are
// this surface's own, because quoting composes a price while the import decomposes a fixed total.
import { CODES_DATALIST, CodesDatalist, CodeField, LineCard, LineSection, inputCls, labelCls } from '@/components/estimate/EstimateShell';

export type EstimateLine = {
  item_type: QuoteItemType; // 'labour' | 'part' | 'misc'
  description: string;
  qty: string;        // hours (labour) / quantity (parts)
  unit_price: string; // rate (labour) / unit price (parts; negative allowed)
  unit_cost: string;  // optional cost each
  vatable: boolean;
  code?: string;                    // catalogue code typed on the line (match key; not persisted)
  catalogue_item_id?: string | null; // origin hook, persisted; remembers the catalogue item it came from
  labour_hours?: number | null; // fixed lines: inherited from the service
};

// Catalogue item (active, tenant-scoped) loaded once for client-side code matching. SIMPLE items only.
export type CatalogueLite = { id: string; code: string; name: string; item_type: QuoteItemType; unit_cost: number | null; unit_price: number; vat_rate: number };

// Fixed-price services are added via a tier picker (not typed codes). Carries components (spec + cost)
// and per-tier price rows so the explosion resolves the price + spec entirely client-side.
export type FixedServiceLite = {
  id: string; code: string; title?: string | null; name: string; basePriceExVat: number; vatRate: number;
  labourHours: number | null; // charged labour content (NOT booking duration)
  components: Array<{ description: string; qty: number; unitCost: number }>;
  tierPrices: Array<{ tierId: string; priceExVat: number | null }>;
};
export type TierLite = { id: string; name: string };

// Internal row = a line plus a stable client id used as the React key.
type Row = EstimateLine & { _uid: string };

let _seq = 0;
const uid = () => `row-${_seq++}`;

type Props = {
  jobCardId: string;
  canEdit: boolean;
  currency: string;
  locale: string;
  initialVatRate: number;
  labourRate?: number | null; // per-site default labour rate (Financial settings) — pre-fills new labour lines
  initialLines: EstimateLine[];
  vatRegistered?: boolean; // master switch; false → no VAT controls, no VAT in totals
  catalogue?: CatalogueLite[]; // active SIMPLE catalogue for code autocomplete (client-side match)
  fixedServices?: FixedServiceLite[]; // active fixed services for the tier picker
  tiers?: TierLite[]; // active tenant tiers
  promos?: PromoLite[]; // active promotions for the apply-promo picker
  priceVisible?: boolean; // finance-shaped: prices absent from props when false (defaults true)
  costVisible?: boolean;  // margin grain: ad-hoc parts editable for cost-visible; else read-only
  canCatalogue?: boolean; // ADMIN — surface "Add to catalogue" on ad-hoc parts (the cost home)
};

const blank = (item_type: QuoteItemType): Row => ({ _uid: uid(), item_type, description: '', qty: '', unit_price: '', unit_cost: '', vatable: true, code: '', catalogue_item_id: null });

// ---- module-scope row component (stable identity → inputs keep focus) ----
type RowProps = {
  row: Row;
  idx: number;
  kind: 'labour' | 'part';
  canEdit: boolean;
  showVat: boolean;
  hasCatalogue: boolean;
  priceVisible: boolean; // finance-shaped server-side — when false the props carry no prices at all
  costVisible: boolean;  // the margin grain; ad-hoc parts editable for cost-visible, else read-only
  canCatalogue: boolean; // ADMIN — may promote an ad-hoc part to the catalogue (the cost home)
  lineTotal: string;
  t: (k: string) => string;
  onChange: (idx: number, patch: Partial<EstimateLine>) => void;
  onCode: (idx: number, code: string) => void;
  onRemove: (idx: number) => void;
};

function LineRow({ row, idx, kind, canEdit, showVat, hasCatalogue, priceVisible, costVisible, canCatalogue, lineTotal, t, onChange, onCode, onRemove }: RowProps) {
  // An ad-hoc part = a parts/misc line with no catalogue origin and no fixed-service labour content,
  // and not a (negative) discount line. Only these have no cost home, so only these accept a typed
  // cost — from a cost-visible user, re-validated server-side. Catalogue/fixed rows show cost read-only.
  const isAdHocPart = kind === 'part' && !row.catalogue_item_id && row.labour_hours == null && Number(row.unit_price || 0) >= 0;
  return (
    <LineCard
      canEdit={canEdit}
      onRemove={() => onRemove(idx)}
      removeLabel={t('estimate.remove')}
      code={hasCatalogue ? (
        <CodeField label={t('estimate.code')} placeholder={t('estimate.codePlaceholder')}
          value={row.code ?? ''} disabled={!canEdit} onChange={(v) => onCode(idx, v)} />
      ) : undefined}
      description={(
        <>
          <label className={`${labelCls} sm:hidden`}>{t('estimate.description')}</label>
          <textarea className={`${inputCls} resize-y`} rows={2} placeholder={t('estimate.descriptionPlaceholder')} value={row.description}
            disabled={!canEdit} onChange={(e) => onChange(idx, { description: e.target.value })} />
        </>
      )}
      fields={(
        <>
      {priceVisible && (
        <div className="sm:w-24">
          <label className={labelCls}>{kind === 'labour' ? t('estimate.rate') : t('estimate.unitPrice')}</label>
          <input className={inputCls} type="number" inputMode="decimal" step="0.01" value={row.unit_price}
            disabled={!canEdit} onChange={(e) => onChange(idx, { unit_price: e.target.value })} />
        </div>
      )}
      <div className="sm:w-20">
        <label className={labelCls}>{kind === 'labour' ? t('estimate.hours') : t('estimate.qty')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" value={row.qty}
          disabled={!canEdit} onChange={(e) => onChange(idx, { qty: e.target.value })} />
      </div>
      {/* COST — TYPED, by cost-visible users only (ruling 2026-07-20, revising 2026-07-12/07-17).
          A fixed-price catalogue is the wrong model for a part: prices move weekly and per supplier,
          so the old "promote it to a product" prompt asked the operator to invent a permanent price
          for a one-off purchase — and meanwhile the line carried NO cost and overstated margin.
          What is preserved: the field is offered only to seeMargin (the server re-derives that and
          ignores any client claim), a catalogue-linked line still inherits its product's cost and
          shows read-only, and BLANK IS NOT ZERO — an empty box stores null (cost unknown, surfaced
          as exposure), a typed 0 stores 0 (known-free). */}
      {costVisible && (isAdHocPart ? (
        <div className="sm:w-28">
          <label className={labelCls}>{t('estimate.cost')}</label>
          <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0"
            placeholder={t('estimate.costUnknown')} value={row.unit_cost}
            disabled={!canEdit} onChange={(e) => onChange(idx, { unit_cost: e.target.value })} />
          {canCatalogue && canEdit && row.description.trim() !== '' && (
            <a href={`/admin/products?add=part&name=${encodeURIComponent(row.description.split('\n')[0].trim())}&price=${encodeURIComponent(row.unit_price)}`}
              target="_blank" rel="noreferrer" title={t('estimate.costHint')}
              className="block text-[11px] text-accent hover:underline mt-0.5 whitespace-nowrap">{t('estimate.addToCatalogue')}</a>
          )}
        </div>
      ) : row.unit_cost !== '' ? (
        <div className="sm:w-24">
          <label className={labelCls}>{t('estimate.cost')}</label>
          {/* Catalogue / fixed lines inherit server-side — read-only by design, not by omission. */}
          <div className="text-muted text-sm tabular-nums py-2">{row.unit_cost}</div>
        </div>
      ) : null)}
      {showVat && (
        <label className="flex items-center gap-2 text-sm text-muted sm:w-16 py-2">
          <input type="checkbox" className="w-5 h-5" checked={row.vatable} disabled={!canEdit}
            onChange={(e) => onChange(idx, { vatable: e.target.checked })} />
          {t('estimate.vat')}
        </label>
      )}
        </>
      )}
      trailing={priceVisible ? (
        <div className="sm:w-24 text-right">
          <label className={`${labelCls} sm:hidden`}>{t('estimate.lineTotal')}</label>
          <div className="text-ink font-medium tabular-nums py-2">{lineTotal}</div>
        </div>
      ) : undefined}
    />
  );
}

// Imperative handle so the ONE unified Quote-tab Save can commit the estimate lines (the standalone
// "Save estimate" button is gone; the parent orchestrates estimate + booking in one action).
/**
 * `terminal` = this save can NEVER succeed (409: the invoice froze at issue). The caller must not
 * retry it and must not trap the operator on the tab. A transient failure — 500, offline — leaves
 * `terminal` false, because there the edit is worth keeping and retrying.
 */
export type CommitResult = { ok: boolean; message?: string; terminal?: boolean };
export type EstimateHandle = { commit: () => Promise<CommitResult> };

const EstimateBuilder = forwardRef<EstimateHandle, Props>(function EstimateBuilder({ jobCardId, canEdit, currency, locale, initialVatRate, labourRate = null, initialLines, vatRegistered = true, catalogue = [], fixedServices = [], tiers = [], promos = [], priceVisible = true, costVisible = false, canCatalogue = false }: Props, ref) {
  const { t } = useTranslation('jobcard');
  const [lines, setLines] = useState<Row[]>(() => initialLines.map((l) => ({ ...l, _uid: uid() })));
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved'); // autosave indicator
  const [pickService, setPickService] = useState('');
  const [pickTier, setPickTier] = useState('');
  const [pickPromo, setPickPromo] = useState('');
  const [promoMsg, setPromoMsg] = useState<string | null>(null);

  // Add a fixed-price service: resolve the tier price + spec entirely client-side and explode into
  // ONE line. The customer-facing line text is the product's Title (heading) + Description (spec) —
  // components are INTERNAL cost-only, they feed unit_cost/margin and are NEVER printed. unit_price =
  // resolved tier price (blank when price-on-the-day); unit_cost = Σ component cost (SILENT).
  function addFixedService() {
    const svc = fixedServices.find((s) => s.id === pickService);
    if (!svc) return;
    const res = resolveTierPrice(svc.basePriceExVat, svc.tierPrices, pickTier || null);
    const desc = fixedLineText(svc.title, svc.name, svc.code);
    const costPounds = svc.components.reduce((s, c) => s + Math.max(0, c.qty) * c.unitCost, 0);
    setLines((p) => [...p, {
      _uid: uid(), item_type: 'fixed',
      description: desc,
      qty: '1',
      unit_price: res.manual || res.pricePounds == null ? '' : String(res.pricePounds),
      unit_cost: costPounds.toFixed(2),
      vatable: svc.vatRate > 0,
      code: '', catalogue_item_id: svc.id,
      labour_hours: svc.labourHours, // charged labour content flows onto the line → invoice grain
    }]);
    setPickService(''); setPickTier('');
  }

  // Client-side, load-once code match (active catalogue only, tenant-scoped by SSR). Case-insensitive.
  const codeIndex = useMemo(() => {
    const m = new Map<string, CatalogueLite>();
    for (const c of catalogue) m.set(c.code.trim().toUpperCase(), c);
    return m;
  }, [catalogue]);
  const hasCatalogue = catalogue.length > 0;

  // Typing a code PRE-FILLS the line (editable defaults; never locks). A code that resolves to a
  // different type re-buckets the line to the correct section. No match → just clears the origin id.
  const onCode = (idx: number, code: string) => {
    const hit = codeIndex.get(code.trim().toUpperCase());
    setLines((p) => p.map((l, i) => {
      if (i !== idx) return l;
      if (!hit) return { ...l, code, catalogue_item_id: null };
      return {
        ...l, code,
        item_type: hit.item_type,
        description: hit.name,
        unit_price: String(hit.unit_price),
        unit_cost: hit.unit_cost == null ? '' : String(hit.unit_cost), // null = UNKNOWN → blank (uncosted), never '0'
        vatable: Number(hit.vat_rate) > 0, // per-line rate maps to the vatable flag; charged at the card rate
        catalogue_item_id: hit.id,
      };
    }));
  };
  const [vatRate, setVatRate] = useState<string>(String(initialVatRate));

  const fmt = (pennies: number) => formatMoney(pennies, { currency, locale });

  // Live totals via the shared chokepoint (index-aligned with `lines`).
  const totals = useMemo(
    () => computeQuoteTotals(
      lines.map((l) => ({
        item_type: l.item_type,
        qty: Number(l.qty || 0),
        unit_price_pennies: poundsToPennies(Number(l.unit_price || 0)),
        vatable: l.vatable,
      })),
      Number(vatRate || 0),
      { vatRegistered },
    ),
    [lines, vatRate, vatRegistered],
  );

  // Apply a discount code → negative EX-VAT discount line(s) via the lib/promo chokepoint. Fixed £ =
  // whole-job; percentage = its targeted products matched to THIS job's lines (each keeping its own VAT
  // flag). Lines are vatable per their flag, so lib/quote-totals reduces ex-VAT + VAT correctly. Ordinary
  // editable/removable lines afterwards. A % promo whose targets aren't on the job → "no applicable items".
  function applyPromo() {
    const promo = promos.find((p) => p.id === pickPromo);
    if (!promo) return;
    const estLines = lines.map((l) => ({
      catalogueItemId: l.catalogue_item_id ?? null,
      title: (l.description || '').split('\n')[0].trim(), // line heading — title-match fallback for refless lines
      exPennies: Math.round(Number(l.unit_price || 0) * Math.max(0, Number(l.qty || 0)) * 100),
      vatable: l.vatable,
    }));
    const discounts = computePromoDiscounts(promo, estLines, Number(vatRate || 0), vatRegistered);
    if (discounts.length === 0) { setPromoMsg(t('estimate.promoNoMatch')); return; }
    setLines((p) => [...p, ...discounts.map((d) => ({
      _uid: uid(), item_type: 'part' as QuoteItemType,
      description: d.label,
      qty: '1',
      unit_price: (-d.exPennies / 100).toFixed(2), // negative ex-VAT = discount
      unit_cost: '0',
      vatable: d.vatable,
      code: '', catalogue_item_id: null,
    }))]);
    setPickPromo(''); setPromoMsg(null);
  }

  const update = (idx: number, patch: Partial<EstimateLine>) =>
    setLines((p) => p.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const remove = (idx: number) => setLines((p) => p.filter((_, i) => i !== idx));
  // New labour lines pre-fill the site's default rate (Financial settings) — editable per line.
  const add = (item_type: QuoteItemType) => setLines((p) => [...p, {
    ...blank(item_type),
    ...(item_type === 'labour' && labourRate != null && labourRate > 0 ? { unit_price: String(labourRate) } : {}),
  }]);

  // THE draft persistence: a serialised snapshot of what's on the server, and the payload builder.
  // The estimate lives on the DRAFT JobCard's JobCardItem rows (Option B) — this writes to them.
  const serialize = (ls: Row[], vr: string) => JSON.stringify({ vatRate: Number(vr || 0), items: ls.map(({ _uid, code, ...rest }) => rest) });
  const lastSavedRef = useRef<string>(serialize(initialLines.map((l) => ({ ...l, _uid: '' } as Row)), String(initialVatRate)));

  // Persist the estimate lines. Also updates lastSavedRef, so autosave never re-posts an unchanged
  // draft after a manual Save. The parent's unified Save uses this via the imperative handle.
  async function commit(): Promise<CommitResult> {
    const snap = serialize(lines, vatRate);
    try {
      const items = lines.map(({ _uid, code, ...rest }) => rest); // strip client-only id + transient code
      const res = await fetch('/api/jobcard-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, vatRate: Number(vatRate || 0), items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // TERMINAL: the estimate is frozen. Mark the draft CLEAN so the autosave stops re-arming —
        // it only skips when `snap === lastSavedRef.current`, so a failed save previously left the
        // component permanently dirty and every later keystroke queued another doomed write.
        if (res.status === 409) {
          lastSavedRef.current = snap;
          return { ok: false, terminal: true, message: data?.message || t('estimate.saveError') };
        }
        return { ok: false, message: data?.message || t('estimate.saveError') };
      }
      lastSavedRef.current = snap; // now on the server
      return { ok: true };
    } catch {
      // Network failure — NOT terminal. Stay dirty so a later change retries.
      return { ok: false, message: t('estimate.saveError') };
    }
  }
  useImperativeHandle(ref, () => ({ commit }), [lines, vatRate, jobCardId]);

  // AUTOSAVE (Option B): debounced write of the draft on every line-item / VAT change, so a quote
  // survives step changes, navigating away and back, and a tab close WITHOUT a manual Save. The draft
  // JobCard is the durable store; this keeps it current. Skips the initial mount and unchanged state;
  // an in-flight write shows "Saving…", a failure keeps the local edit and the manual Save as a retry.
  const didMountRef = useRef(false);
  const frozenRef = useRef(false); // set by a 409 — the card froze under us mid-edit
  useEffect(() => {
    const snap = serialize(lines, vatRate);
    if (!didMountRef.current) { didMountRef.current = true; lastSavedRef.current = snap; return; }
    if (!canEdit || snap === lastSavedRef.current) return; // read-only, or nothing changed
    if (frozenRef.current) return; // a 409 already told us this card can never accept a write
    setSaveState('saving');
    const timer = setTimeout(async () => {
      const r = await commit(); // commit() reads the current lines/vatRate + updates lastSavedRef
      if (r.terminal) frozenRef.current = true; // stop autosaving for the life of this mount
      setSaveState(r.ok ? 'saved' : 'error');
    }, 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, vatRate, canEdit]);

  // Each row carries its original index so per-line totals map back to totals.lines[idx].
  const withIdx = lines.map((l, idx) => ({ l, idx }));
  const labour = withIdx.filter((x) => x.l.item_type === 'labour');
  const parts = withIdx.filter((x) => x.l.item_type !== 'labour' && x.l.item_type !== 'fixed');
  const fixed = withIdx.filter((x) => x.l.item_type === 'fixed'); // published bundles — own section

  return (
    <div className="bg-surface border border-line rounded-xl p-5 mt-6">
      {hasCatalogue && <CodesDatalist codes={catalogue} />}
      <div className="flex items-center justify-between gap-2 mb-1">
        <h2 className="text-lg font-semibold text-ink">{t('estimate.title')}</h2>
        {/* Autosave status — the quote is saved as you build it (Option B: the draft is the store). */}
        {canEdit && (
          <span className={`text-xs ${saveState === 'error' ? 'text-danger' : 'text-muted'}`}>
            {saveState === 'saving' ? t('estimate.autosaveSaving') : saveState === 'error' ? t('estimate.autosaveError') : t('estimate.autosaveSaved')}
          </span>
        )}
      </div>
      {!canEdit && <p className="text-warn text-sm mb-3">{t('estimate.readOnly')}</p>}

      {/* Labour */}
      <LineSection title={t('estimate.labour')} empty={t('estimate.emptyLabour')} isEmpty={labour.length === 0}
        addLabel={canEdit ? t('estimate.addLabour') : undefined} onAdd={canEdit ? () => add('labour') : undefined}>
        {labour.map(({ l, idx }) => (
          <LineRow key={l._uid} row={l} idx={idx} kind="labour" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={hasCatalogue} priceVisible={priceVisible} costVisible={costVisible} canCatalogue={canCatalogue}
            lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t} onChange={update} onCode={onCode} onRemove={remove} />
        ))}
      </LineSection>

      {/* Parts */}
      <LineSection title={t('estimate.parts')} empty={t('estimate.emptyParts')} isEmpty={parts.length === 0}
        className="mt-4" addLabel={canEdit ? t('estimate.addParts') : undefined}
        onAdd={canEdit ? () => add('part') : undefined} hint={canEdit ? t('estimate.discountHint') : undefined}>
        {parts.map(({ l, idx }) => (
          <LineRow key={l._uid} row={l} idx={idx} kind="part" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={hasCatalogue} priceVisible={priceVisible} costVisible={costVisible} canCatalogue={canCatalogue}
            lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t} onChange={update} onCode={onCode} onRemove={remove} />
        ))}
      </LineSection>

      {/* Fixed-price services — published bundles (price-led; cost optional). Shown only if in use
          or the estimate is editable, so it doesn't clutter a card that has none. */}
      {(fixed.length > 0 || canEdit) && (
        <>
          <h3 className="text-sm font-semibold text-ink mt-4 mb-2">{t('estimate.fixed')}</h3>
          {fixed.length === 0 && <p className="text-muted text-sm mb-2">{t('estimate.emptyFixed')}</p>}
          {fixed.map(({ l, idx }) => (
            <div key={l._uid}>
              <LineRow row={l} idx={idx} kind="part" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={false} priceVisible={priceVisible} costVisible={costVisible} canCatalogue={canCatalogue}
                lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t} onChange={update} onCode={onCode} onRemove={remove} />
              {l.labour_hours != null && (
                <p className="text-xs text-muted -mt-1 mb-2">{t('estimate.fixedHours', { hours: l.labour_hours })}</p>
              )}
            </div>
          ))}
          {canEdit && (
            fixedServices.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2 mb-4">
                <select value={pickService} onChange={(e) => setPickService(e.target.value)} className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink">
                  <option value="">{t('estimate.pickService')}</option>
                  {fixedServices.map((s) => <option key={s.id} value={s.id}>{s.title || s.code}</option>)}
                </select>
                {tiers.length > 0 && (
                  <select value={pickTier} onChange={(e) => setPickTier(e.target.value)} className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink">
                    <option value="">{t('estimate.pickTierBase')}</option>
                    {tiers.map((tt) => <option key={tt.id} value={tt.id}>{tt.name}</option>)}
                  </select>
                )}
                <button onClick={addFixedService} disabled={!pickService} className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2 disabled:opacity-50">+ {t('estimate.addFixed')}</button>
              </div>
            ) : (
              <p className="text-xs text-muted mb-4">{t('estimate.noFixedServices')}</p>
            )
          )}
        </>
      )}

      {/* Discount codes — apply a promo as correctly VAT-split negative line(s). */}
      {canEdit && promos.length > 0 && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{t('estimate.promo')}</span>
            <select value={pickPromo} onChange={(e) => { setPickPromo(e.target.value); setPromoMsg(null); }} className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink">
              <option value="">{t('estimate.pickPromo')}</option>
              {promos.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.label}</option>)}
            </select>
            <button onClick={applyPromo} disabled={!pickPromo} className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2 disabled:opacity-50">{t('estimate.applyPromo')}</button>
          </div>
          {promoMsg && <p className="text-xs text-warn mt-1">{promoMsg}</p>}
        </div>
      )}

      {/* VAT rate + summary. VAT rate + line hidden entirely when the tenant isn't VAT registered. */}
      <div className="border-t border-line mt-4 pt-4 flex flex-col sm:flex-row sm:justify-between gap-4">
        {vatRegistered ? (
          <div className="sm:w-40">
            <label className={labelCls}>{t('estimate.vatRate')}</label>
            <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" max="100" value={vatRate}
              disabled={!canEdit} onChange={(e) => setVatRate(e.target.value)} />
          </div>
        ) : (
          <div className="hidden sm:block" />
        )}
        {priceVisible && (
          <div className="text-sm space-y-1 sm:w-64">
            <div className="flex justify-between"><span className="text-muted">{t('estimate.summaryLabour')}</span><span className="text-ink tabular-nums">{fmt(totals.labour_pennies)}</span></div>
            <div className="flex justify-between"><span className="text-muted">{t('estimate.summaryParts')}</span><span className="text-ink tabular-nums">{fmt(totals.parts_pennies)}</span></div>
            {vatRegistered && (
              <div className="flex justify-between"><span className="text-muted">{t('estimate.summaryVat')}</span><span className="text-ink tabular-nums">{fmt(totals.vat_pennies)}</span></div>
            )}
            <div className="flex justify-between text-base font-semibold border-t border-line pt-1"><span className="text-ink">{t('estimate.summaryTotal')}</span><span className="text-ink tabular-nums">{fmt(totals.total_pennies)}</span></div>
          </div>
        )}
      </div>

    </div>
  );
});

export default EstimateBuilder;
