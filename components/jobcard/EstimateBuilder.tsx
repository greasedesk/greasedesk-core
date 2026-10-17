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
import { resolveTierPrice, tierOffers, tierPricePounds, fixedLineText } from '@/lib/catalogue';
import { ladderForItem, rungsFor, type SetMemberInput } from '@/lib/catalogue-sets';
import { PromoLite, computePromoDiscounts } from '@/lib/promo';
import { formatMoney } from '@/lib/format-money';
import { lineFlags, toPlausible } from '@/lib/line-plausibility';
// THE SHARED SHAPE (sections, row card, code autocomplete). Layout only — the fields below are
// this surface's own, because quoting composes a price while the import decomposes a fixed total.
import { CODES_DATALIST, CodesDatalist, CodeField, LineCard, LineSection, inputCls, labelCls } from '@/components/estimate/EstimateShell';

export type EstimateLine = {
  /** The row this line already IS on the card, absent on a new one. Sent back on save so the
   *  server updates in place instead of recreating — which is what lets a DueItemLine survive. */
  id?: string;
  item_type: QuoteItemType; // 'labour' | 'part' | 'misc'
  description: string;
  qty: string;        // hours (labour) / quantity (parts)
  unit_price: string; // rate (labour) / unit price (parts; negative allowed)
  unit_cost: string;  // optional cost each
  vatable: boolean;
  code?: string;                    // catalogue code typed on the line (match key; not persisted)
  catalogue_item_id?: string | null; // origin hook, persisted; remembers the catalogue item it came from
  labour_hours?: number | null; // fixed lines: inherited from the service
  /** Which draft option this line belongs to. NULL = the main quote — the same rule the frozen
   *  side and the customer's page use. */
  option_draft_id?: string | null;
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

/**
 * ── A DRAFT OPTION, AS THE BUILDER HOLDS IT ────────────────────────────────────────────────────
 * Mirrors QuoteOptionDraft. `id` may be provisional for an option added in this session; the save
 * endpoint maps a provisional id to the stored one for the lines pointing at it, so a line can be
 * assigned to an option that does not exist on the server yet.
 */
/**
 * A GROUP THE BUILDER MADE BECAUSE OF SOMETHING YOU DID. There is no "create a group" button: you
 * drop an icon on a line you have already quoted, and the group exists with that line in it. Which
 * icon decides the SHAPE, and the shape decides what choosing means (lib/quote-options).
 */
/**
 * A SET, AS THE BUILDER RECEIVES IT — members already joined to their pricing, because the ladder
 * has to show real figures the instant the icon is pressed and a second fetch at that moment is a
 * spinner where a price should be.
 */
export type CatalogueSetLite = {
  id: string;
  name: string;
  shape: 'pick_one' | 'base_plus_extras';
  members: SetMemberInput[];
};

export type DraftGroup = {
  id: string;
  shape: 'pick_one' | 'base_plus_extras';
  title: string;
};

export type DraftOption = {
  id: string;
  /** The group it belongs to — every option has one. `kind` is the retiring flat shape. */
  group_id: string;
  /** base_plus_extras only: the job the extras hang off, and the line you dropped the icon on. */
  is_base: boolean;
  title: string;
  position: number;
  incentive_kind: 'amount_off' | 'included' | 'percent_off' | null;
  /** percent_off only: the rate, in basis points. The PENNIES are resolved at freeze. */
  incentive_percent_bp: number | null;
  incentive_label: string | null;
  incentive_ex_pennies: number | null;
  incentive_vatable: boolean | null;
  incentive_gross_off_pennies: number | null;
};

let _seq = 0;
const uid = () => `row-${_seq++}`;
/**
 * A PROVISIONAL ID FOR A ROW THE SERVER HAS NOT SEEN YET — one monotonic counter, never a clock.
 *
 * These were `g-${Date.now()}`, `new-${Date.now()}` and `new-${Date.now()}-${os.length}`, which
 * carried two collision classes: two drops inside the same millisecond, and a length-derived
 * suffix that repeats as soon as an option is removed. They are map KEYS on the way back from the
 * save, so a repeat silently assigns one stored id to two different rows.
 */
const provisional = (prefix: string) => `${prefix}-${_seq++}`;

type Props = {
  jobCardId: string;
  canEdit: boolean;
  currency: string;
  locale: string;
  initialVatRate: number;
  labourRate?: number | null; // per-site default labour rate (Financial settings) — pre-fills new labour lines
  initialLines: EstimateLine[];
  initialOptions?: DraftOption[];   // the card's draft options; absent = none authored yet
  initialGroups?: DraftGroup[];     // …and the groups they sit in
  catalogueSets?: CatalogueSetLite[]; // named product sets — what the ladder icon can reach
  vatRegistered?: boolean; // master switch; false → no VAT controls, no VAT in totals
  catalogue?: CatalogueLite[]; // active SIMPLE catalogue for code autocomplete (client-side match)
  fixedServices?: FixedServiceLite[]; // active fixed services for the tier picker
  tiers?: TierLite[]; // active tenant tiers
  promos?: PromoLite[]; // active promotions for the apply-promo picker
  priceVisible?: boolean; // finance-shaped: prices absent from props when false (defaults true)
  costVisible?: boolean;  // margin grain: ad-hoc parts editable for cost-visible; else read-only
  canCatalogue?: boolean; // ADMIN — surface "Add to catalogue" on ad-hoc parts (the cost home)
  onSaved?: () => void; // fires after ANY successful persist (manual, autosave, parent commit) —
                        // mirrors the server clearing costs_inherited on save, so the duplicated-card
                        // stale-cost advisory drops without a reload
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
  onFieldBlur?: () => void; // qty / unit-price blur → reveal the plausibility note (Surface 1)
};

function LineRow({ row, idx, kind, canEdit, showVat, hasCatalogue, priceVisible, costVisible, canCatalogue, lineTotal, t, onChange, onCode, onRemove, onFieldBlur }: RowProps) {
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
            disabled={!canEdit} onChange={(e) => onChange(idx, { unit_price: e.target.value })} onBlur={onFieldBlur} />
        </div>
      )}
      <div className="sm:w-20">
        <label className={labelCls}>{kind === 'labour' ? t('estimate.hours') : t('estimate.qty')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" value={row.qty}
          disabled={!canEdit} onChange={(e) => onChange(idx, { qty: e.target.value })} onBlur={onFieldBlur} />
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

// Surface 1 — the inline plausibility note under a parts row (revealed on qty/price blur). Advisory,
// never blocking. For rule B it offers the deterministic one-click fix (qty→1, price→old qty).
function LinePlausibilityNote({ row, idx, show, justFixed, canEdit, costVisible, labourRate, t, onFix }: {
  row: Row; idx: number; show: boolean; justFixed: boolean; canEdit: boolean; costVisible: boolean;
  labourRate?: number | null;
  t: (k: string, o?: any) => string; onFix: (idx: number, fixUnitPrice: number) => void;
}) {
  if (!show) return null;
  const flags = lineFlags(toPlausible(row), { postedLabourRate: labourRate ?? null });
  if (!flags.length && !justFixed) return null;
  const m = (x: number) => x.toFixed(2);
  return (
    <div className="-mt-2 mb-2 sm:pl-2 space-y-1" role="status">
      {flags.map((f, i) => {
        if (f.rule === 'B') return (
          <div key={i} className="text-xs text-warn flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>⚠ {t('estimate.warnPriceInQty', { qty: Number(row.qty) })}</span>
            {canEdit && <button type="button" onClick={() => onFix(idx, f.fixUnitPrice)} className="underline font-medium hover:text-ink">{t('estimate.warnFix', { price: m(f.fixUnitPrice) })}</button>}
          </div>
        );
        if (f.rule === 'A') return <div key={i} className="text-xs text-warn">⚠ {t('estimate.warnQtyHigh', { qty: Number(row.qty) })}</div>;
        if (f.rule === 'E') return <div key={i} className="text-xs text-warn">⚠ {t('estimate.warnQtyImplausible', { qty: Number(row.qty) })}</div>;
        // L1 / L2 — labour priced far below the posted rate: money typed into the hours box. WARN
        // ONLY: the money is recoverable but the true hours are not, so we ask rather than guess.
        if (f.rule === 'L1') return <div key={i} className="text-xs text-warn" data-testid="warn-L1">⚠ {f.rate == null ? t('estimate.warnLabourFloor', { price: m(f.price) }) : t('estimate.warnLabourRate', { price: m(f.price), rate: m(f.rate), total: m(Number(row.qty) * f.price) })}</div>;
        if (f.rule === 'L2') return <div key={i} className="text-xs text-warn" data-testid="warn-L2">⚠ {t('estimate.warnLabourHours', { qty: f.qty, price: m(f.price), rate: m(f.rate) })}</div>;
        // C — only surfaced to cost-visible users (the cost column is theirs).
        return costVisible ? <div key={i} className="text-xs text-warn">⚠ {t('estimate.warnCostOverRetail', { cost: m(f.cost), retail: m(f.retail) })}</div> : null;
      })}
      {justFixed && <div className="text-xs text-warn">✓ {t('estimate.warnFixed')}</div>}
    </div>
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
export type EstimateHandle = { commit: () => Promise<CommitResult>; lines: () => EstimateLine[] };

const EstimateBuilder = forwardRef<EstimateHandle, Props>(function EstimateBuilder({ jobCardId, canEdit, currency, locale, initialVatRate, labourRate = null, initialLines, initialOptions, initialGroups = [], catalogueSets = [], vatRegistered = true, catalogue = [], fixedServices = [], tiers = [], promos = [], priceVisible = true, costVisible = false, canCatalogue = false, onSaved }: Props, ref) {
  const { t } = useTranslation('jobcard');
  // SEEDED FROM THE SERVER ID where the line already exists. _uid is still just React's key — its
  // job is focus retention across a keystroke — but keying it to the real row means a re-render
  // cannot silently detach a line from the row it represents. A NEW row has no id and mints one.
  const [lines, setLines] = useState<Row[]>(() => initialLines.map((l) => ({ ...l, _uid: l.id ?? uid() })));
  const [options, setOptions] = useState<DraftOption[]>(initialOptions ?? []);
  const [groups, setGroups] = useState<DraftGroup[]>(initialGroups);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved'); // autosave indicator
  const [pickService, setPickService] = useState('');
  const [pickTier, setPickTier] = useState('');
  /** Named rather than silent: the service the chosen tier does not offer. Cleared on every change
   *  of either picker, so it describes the CURRENT pair and never an earlier one. */
  const [tierRefusal, setTierRefusal] = useState<string | null>(null);
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
    // NOT OFFERED TO THIS TIER is a refusal, not a blank price. Adding the line anyway would put an
    // oil service on an electric car's quote with an empty box, which reads as "we forgot the
    // price" rather than "this car cannot have this".
    if (!tierOffers(res)) { setTierRefusal(svc.title || svc.name); return; }
    const priced = tierPricePounds(res);
    const desc = fixedLineText(svc.title, svc.name, svc.code);
    const costPounds = svc.components.reduce((s, c) => s + Math.max(0, c.qty) * c.unitCost, 0);
    setLines((p) => [...p, {
      _uid: uid(), item_type: 'fixed',
      description: desc,
      qty: '1',
      unit_price: priced == null ? '' : String(priced),
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

  // Surface-1 plausibility state: which rows have been blurred (so the note appears on blur, not
  // mid-type) and which have just had the one-click fix applied (to show the "check the cost" note).
  const [blurredUids, setBlurredUids] = useState<Set<string>>(() => new Set());
  const [fixedUids, setFixedUids] = useState<Set<string>>(() => new Set());
  const markBlurred = (u: string) => setBlurredUids((s) => (s.has(u) ? s : new Set(s).add(u)));
  const applyLineFix = (idx: number, u: string, fixUnitPrice: number) => {
    update(idx, { qty: '1', unit_price: fixUnitPrice.toFixed(2) }); // retail = qty×£1 preserved exactly
    setFixedUids((s) => new Set(s).add(u));
  };
  const remove = (idx: number) => setLines((p) => p.filter((_, i) => i !== idx));
  // New labour lines pre-fill the site's default rate (Financial settings) — editable per line.
  const add = (item_type: QuoteItemType) => setLines((p) => [...p, {
    ...blank(item_type),
    ...(item_type === 'labour' && labourRate != null && labourRate > 0 ? { unit_price: String(labourRate) } : {}),
  }]);

  // THE draft persistence: a serialised snapshot of what's on the server, and the payload builder.
  // The estimate lives on the DRAFT JobCard's JobCardItem rows (Option B) — this writes to them.
  // Options are part of what a save persists, so they are part of what "dirty" means. Leaving them
  // out would make renaming an option or changing an incentive a change the autosave cannot see.
  /**
   * ── ONE SHAPE, BUILT ONCE ───────────────────────────────────────────────────────────────────
   * The dirty-compare string and the POST body were two separate spellings of the same object.
   * They agreed by inspection, which is the weakest way for two things to agree: a field added to
   * one and not the other makes the autosave blind to an edit it is faithfully sending.
   *
   * `uid` rides along because a NEW line has no id, and the server's answer has to be addressed to
   * something. It is the React key, which is stable for the life of the row, so it does not make
   * an unchanged draft look dirty.
   */
  const payloadOf = (ls: Row[], vr: string, os: DraftOption[], gs: DraftGroup[]) => ({
    vatRate: Number(vr || 0),
    items: ls.map(({ _uid, code, ...rest }) => ({ ...rest, uid: _uid })),
    options: os,
    groups: gs,
  });
  const serialize = (ls: Row[], vr: string, os: DraftOption[] = options, gs: DraftGroup[] = groups) =>
    JSON.stringify(payloadOf(ls, vr, os, gs));
  const lastSavedRef = useRef<string>(serialize(initialLines.map((l) => ({ ...l, _uid: '' } as Row)), String(initialVatRate)));

  // Persist the estimate lines. Also updates lastSavedRef, so autosave never re-posts an unchanged
  // draft after a manual Save. The parent's unified Save uses this via the imperative handle.
  async function commit(): Promise<CommitResult> {
    const sent = payloadOf(lines, vatRate, options, groups);
    const snap = JSON.stringify(sent);
    try {
      const res = await fetch('/api/jobcard-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, ...sent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // TERMINAL FOR THIS DRAFT — two different 409s now reach here. `invoice_frozen` means the
        // estimate can no longer change at all; `line_gone` means somebody else moved it while this
        // form was open. Both want the same handling: stop re-arming the autosave, because retrying
        // an identical payload fails identically, and show the server's sentence, which says which
        // it was and what to do about it.
        // Mark the draft CLEAN so the autosave stops re-arming —
        // it only skips when `snap === lastSavedRef.current`, so a failed save previously left the
        // component permanently dirty and every later keystroke queued another doomed write.
        if (res.status === 409) {
          lastSavedRef.current = snap;
          return { ok: false, terminal: true, message: data?.message || t('estimate.saveError') };
        }
        return { ok: false, message: data?.message || t('estimate.saveError') };
      }
      /**
       * ── ADOPT THE IDS THE SERVER MINTED ───────────────────────────────────────────────────
       * Until this existed, a row the estimator typed was deleted and recreated on EVERY later
       * autosave: the browser re-sent the provisional id, the server found no such row, removed
       * the one it had made 900ms earlier and made another. Options and groups churned the same
       * way, and anything pointing at a line — DueItemLine above all — went with it.
       *
       * Applied through the SAME adopt functions that build the new baseline, so the string the
       * autosave compares against cannot drift from the state it describes. Written as functional
       * updates because the estimator may have typed while this request was in flight: the maps
       * are applied to whatever is on screen NOW, not to the snapshot that was sent.
       */
      const ids = (data?.ids ?? {}) as { groups?: Record<string, string>; options?: Record<string, string>; lines?: Record<string, string> };
      const g = (x: string) => ids.groups?.[x] ?? x;
      const o = (x: string) => ids.options?.[x] ?? x;
      const adoptG = (x: DraftGroup): DraftGroup => ({ ...x, id: g(x.id) });
      const adoptO = (x: DraftOption): DraftOption => ({ ...x, id: o(x.id), group_id: g(x.group_id) });
      const adoptL = (x: Row): Row => ({
        ...x,
        id: x.id ?? ids.lines?.[x._uid],
        option_draft_id: x.option_draft_id ? o(x.option_draft_id) : x.option_draft_id,
      });
      const minted = Object.keys(ids.groups ?? {}).length + Object.keys(ids.options ?? {}).length + Object.keys(ids.lines ?? {}).length;
      if (minted > 0) {
        setGroups((gs) => gs.map(adoptG));
        setOptions((os) => os.map(adoptO));
        setLines((ls) => ls.map(adoptL));
      }
      // THE BASELINE DESCRIBES WHAT THE SERVER NOW HOLDS, under the ids it holds it under — built
      // from the payload that was SENT, never from current state, so an edit made mid-flight stays
      // dirty and gets its own save.
      lastSavedRef.current = minted > 0
        ? JSON.stringify(payloadOf(lines.map(adoptL), vatRate, options.map(adoptO), groups.map(adoptG)))
        : snap;
      onSaved?.(); // the server just cleared costs_inherited — let the advisory drop live
      return { ok: true };
    } catch {
      // Network failure — NOT terminal. Stay dirty so a later change retries.
      return { ok: false, message: t('estimate.saveError') };
    }
  }
  // Expose the LIVE lines so the pre-issue check reads what is about to freeze (not the page's
  // load-time snapshot, which goes stale the moment the estimate is edited in-session).
  useImperativeHandle(ref, () => ({ commit, lines: () => lines.map(({ _uid, ...rest }) => rest) }), [lines, vatRate, jobCardId]);

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
    // `options` BELONGS HERE. It is part of what a save persists and part of what `serialize`
    // compares, so leaving it out made renaming an option or setting an incentive a change the
    // autosave could not see — the edit sat in local state and was lost on navigate. Found by a
    // gate that typed an incentive on the real screen and found nulls in the database.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, vatRate, canEdit, options, groups]);   // `groups` BELONGS HERE: renaming a group is a
  // change `serialize` can see, so leaving it out would make the autosave blind to it.

  // Each row carries its original index so per-line totals map back to totals.lines[idx].
  /**
   * ── THE GROUP EXISTS BECAUSE OF WHAT YOU DID ────────────────────────────────────────────────
   * There is no "create a group" button. You drop an icon on a line you have ALREADY quoted, and
   * the group arrives with that line in it, plus one empty sibling to type. Which icon decides the
   * SHAPE, and the shape decides what choosing means (lib/quote-options):
   *
   *   alternatives → pick_one: the line becomes one of the choices, and declining them all is a
   *                  legitimate answer, so the work leaves the main quote.
   *   extras       → base_plus_extras: the line stays as the job being done and becomes the BASE,
   *                  and the extras hang off it — orderable only while it is.
   *
   * Either way the line moves OUT of the main quote and into the group, because a line that is
   * both the main quote and a choice would be billed twice if the choice were taken.
   */
  const makeGroup = (shape: DraftGroup['shape'], lineUid: string) => {
    const line = lines.find((l) => l._uid === lineUid);
    const name = (line?.description || '').trim();
    const gid = provisional('g');
    const oid = provisional('new');
    // NOT `blank` — that is the module-level row factory, and shadowing it here made
    // `blank('fixed')` a call on an object literal. Named for what it holds.
    const noIncentive = {
      incentive_kind: null, incentive_percent_bp: null, incentive_label: null,
      incentive_ex_pennies: null, incentive_vatable: null, incentive_gross_off_pennies: null,
    } as const;

    /**
     * ── THE LADDER, WHEN THE LINE'S PRODUCT IS IN ONE ────────────────────────────────────────
     * Drop the alternatives icon on Bronze and the other rungs arrive WITH THEIR PRICES, as lines
     * of their own inside their own options. Without this an option could only ever hold work
     * already typed on the estimate, so "offer alternatives" on Bronze offered Bronze again.
     *
     * EVERY RUNG, INCLUDING THE CHEAPER ONES. A customer moving down from Gold to Silver is still
     * a sale, and a ladder that only points upwards turns a hesitation into a walk-out. The set's
     * order is the order; the direction is nobody's. A rung the car's tier marks not_applicable is
     * simply ABSENT — rungsFor drops it — because a greyed-out oil service on an electric car
     * explains the catalogue rather than telling the customer anything.
     */
    const ladder = shape === 'pick_one' ? ladderForItem(catalogueSets, line?.catalogue_item_id ?? null) : null;
    const rungs = ladder ? rungsFor(ladder.members, pickTier || null).filter((r) => r.catalogueItemId !== line?.catalogue_item_id) : [];

    setGroups((gs) => [...gs, {
      id: gid, shape,
      title: ladder?.name || name || (shape === 'pick_one' ? 'Choose one' : 'Extras'),
    }]);

    if (rungs.length) {
      // One option per rung, each holding one line priced from the catalogue. The dropped line
      // keeps its own option and stays exactly as the estimator priced it — the ladder adds
      // alternatives, it never re-prices the work already agreed on the card.
      const made = rungs.map((r) => ({ r, optId: provisional('new'), uid: uid() }));
      setOptions((os) => [
        ...os,
        { id: oid, group_id: gid, is_base: false, title: name || 'This job', position: os.length, ...noIncentive },
        ...made.map((m, i) => ({ id: m.optId, group_id: gid, is_base: false, title: m.r.title, position: os.length + 1 + i, ...noIncentive })),
      ]);
      setLines((ls) => [
        ...ls.map((x) => (x._uid === lineUid ? { ...x, option_draft_id: oid } : x)),
        ...made.map((m) => ({
          ...blank('fixed'),
          _uid: m.uid,
          description: m.r.title,
          qty: '1',
          // NULL price is "priced on the day" and arrives as an EMPTY box, never as 0 — which
          // would print as free on the customer's copy.
          unit_price: m.r.pricePounds == null ? '' : String(m.r.pricePounds),
          vatable: m.r.vatRate > 0,
          catalogue_item_id: m.r.catalogueItemId,
          labour_hours: m.r.labourHours,
          option_draft_id: m.optId,
        })),
      ]);
      return;
    }

    setOptions((os) => [...os,
      { id: oid, group_id: gid, is_base: shape === 'base_plus_extras', title: name || 'This job', position: os.length, ...noIncentive },
      { id: provisional('new'), group_id: gid, is_base: false, position: os.length + 1, ...noIncentive,
        title: shape === 'pick_one' ? 'Another choice' : 'An extra' },
    ]);
    setLines((ls) => ls.map((x) => (x._uid === lineUid ? { ...x, option_draft_id: oid } : x)));
  };

  /** The two icons, on any line not already in a group. */
  const GroupIcons = ({ l }: { l: Row }) => (!canEdit || l.option_draft_id ? null : (
    <div className="flex gap-2 mb-2 -mt-1" data-testid="group-icons" data-line={l._uid}>
      <button type="button" data-testid="offer-alternatives"
        className="text-xs rounded-lg px-2 py-1 bg-surface-muted border border-line text-muted hover:text-ink"
        onClick={() => makeGroup('pick_one', l._uid)}>⇅ Offer alternatives</button>
      <button type="button" data-testid="add-extras"
        className="text-xs rounded-lg px-2 py-1 bg-surface-muted border border-line text-muted hover:text-ink"
        onClick={() => makeGroup('base_plus_extras', l._uid)}>＋ Add extras</button>
    </div>
  ));

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
        {/* `data-state` carries the state in English for a gate to wait on: the TEXT is translated
            and must stay that way, and a clause keyed to translated words asserts the locale file
            as much as the behaviour. */}
        {canEdit && (
          <span data-testid="autosave-state" data-state={saveState} className={`text-xs ${saveState === 'error' ? 'text-danger' : 'text-muted'}`}>
            {saveState === 'saving' ? t('estimate.autosaveSaving') : saveState === 'error' ? t('estimate.autosaveError') : t('estimate.autosaveSaved')}
          </span>
        )}
      </div>
      {!canEdit && <p className="text-warn text-sm mb-3">{t('estimate.readOnly')}</p>}

      {/* Labour */}
      <LineSection title={t('estimate.labour')} empty={t('estimate.emptyLabour')} isEmpty={labour.length === 0}
        addLabel={canEdit ? t('estimate.addLabour') : undefined} onAdd={canEdit ? () => add('labour') : undefined}>
        {labour.map(({ l, idx }) => (
          <React.Fragment key={l._uid}>
            <LineRow row={l} idx={idx} kind="labour" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={hasCatalogue} priceVisible={priceVisible} costVisible={costVisible} canCatalogue={canCatalogue}
              lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t} onChange={update} onCode={onCode} onRemove={remove}
              onFieldBlur={() => markBlurred(l._uid)} />
            <GroupIcons l={l} />
            {/* Labour rules L1/L2 (2026-07-29) — this note did not exist on labour rows before, because
                every rule was parts-only. Warn-only: no fix button is offered for labour. */}
            <LinePlausibilityNote row={l} idx={idx} show={blurredUids.has(l._uid)} justFixed={false} canEdit={canEdit} costVisible={costVisible} labourRate={labourRate} t={t} onFix={() => {}} />
          </React.Fragment>
        ))}
      </LineSection>

      {/* Parts */}
      <LineSection title={t('estimate.parts')} empty={t('estimate.emptyParts')} isEmpty={parts.length === 0}
        className="mt-4" addLabel={canEdit ? t('estimate.addParts') : undefined}
        onAdd={canEdit ? () => add('part') : undefined} hint={canEdit ? t('estimate.discountHint') : undefined}>
        {parts.map(({ l, idx }) => (
          <React.Fragment key={l._uid}>
            <LineRow row={l} idx={idx} kind="part" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={hasCatalogue} priceVisible={priceVisible} costVisible={costVisible} canCatalogue={canCatalogue}
              lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t}
              onChange={(i, patch) => { update(i, patch); if (('qty' in patch || 'unit_price' in patch) && fixedUids.has(l._uid)) setFixedUids((s) => { const n = new Set(s); n.delete(l._uid); return n; }); }}
              onCode={onCode} onRemove={remove} onFieldBlur={() => markBlurred(l._uid)} />
            <GroupIcons l={l} />
            <LinePlausibilityNote row={l} idx={idx} show={blurredUids.has(l._uid)} justFixed={fixedUids.has(l._uid)} canEdit={canEdit} costVisible={costVisible} labourRate={labourRate} t={t} onFix={(i, fp) => applyLineFix(i, l._uid, fp)} />
          </React.Fragment>
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
              <GroupIcons l={l} />
              {l.labour_hours != null && (
                <p className="text-xs text-muted -mt-1 mb-2">{t('estimate.fixedHours', { hours: l.labour_hours })}</p>
              )}
            </div>
          ))}
          {canEdit && (
            fixedServices.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2 mb-4">
                <select value={pickService} onChange={(e) => { setTierRefusal(null); setPickService(e.target.value); }} className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink">
                  <option value="">{t('estimate.pickService')}</option>
                  {fixedServices.map((s) => <option key={s.id} value={s.id}>{s.title || s.code}</option>)}
                </select>
                {/* The tier is read by the LADDER too, not only by "add a fixed service": it is
                    what decides which rungs a particular car is offered. */}
                {tiers.length > 0 && (
                  <select value={pickTier} data-testid="estimate-tier" onChange={(e) => { setTierRefusal(null); setPickTier(e.target.value); }} className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink">
                    <option value="">{t('estimate.pickTierBase')}</option>
                    {tiers.map((tt) => <option key={tt.id} value={tt.id}>{tt.name}</option>)}
                  </select>
                )}
                <button onClick={addFixedService} disabled={!pickService} className="text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2 disabled:opacity-50">+ {t('estimate.addFixed')}</button>
                {/* NAMED, not a blank price. The refusal sits with the pickers that produced it. */}
                {tierRefusal && (
                  <p className="basis-full text-xs text-warn" data-testid="tier-not-applicable">
                    {t('estimate.tierNotApplicable', { service: tierRefusal })}
                  </p>
                )}
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

      {/* ── OPTIONS ─────────────────────────────────────────────────────────────────────────────
          Where a garage builds "the main job, plus any of these, or one of those". Lines are
          assigned from HERE rather than with a dropdown on every row: the grouping is one decision
          about the whole quote, and reading it in one place is how you see that bronze/silver/gold
          are alternatives rather than three separate extras.

          A line not ticked anywhere is the MAIN quote. That is the same rule the frozen side uses
          (QuoteVersionLine.option_id NULL) and the same one the customer's page reads. */}
      {canEdit && (
        <div className="border-t border-line mt-4 pt-4" data-testid="estimate-options">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-sm font-semibold text-ink">Options</span>
          </div>
          {groups.length === 0 && (
            <p className="text-xs text-muted" data-testid="no-options">
              No options yet. On any line above, <strong>Offer alternatives</strong> turns it into a
              choice the customer picks one of, and <strong>Add extras</strong> keeps it and offers
              more alongside it. They can decline either.
            </p>
          )}
          {groups.map((g, gi) => {
            const mine = options.map((o, oi) => ({ o, oi })).filter((x) => x.o.group_id === g.id);
            return (
              <div key={g.id} className="rounded-lg border border-line p-3 mb-2"
                data-testid="group-editor" data-group={g.id} data-shape={g.shape}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted">
                    {g.shape === 'pick_one' ? 'Choose one of' : 'Plus any of'}
                  </span>
                  <input className={inputCls} style={{ maxWidth: 220 }} value={g.title} data-testid="group-title"
                    onChange={(e) => setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, title: e.target.value } : x)))} />
                  <button type="button" data-testid="add-option" className="text-sm rounded-lg px-3 py-1.5 bg-surface-muted border border-line text-ink"
                    onClick={() => setOptions((os) => [...os, {
                      id: provisional('new'), group_id: g.id, is_base: false,
                      title: g.shape === 'pick_one' ? 'Another choice' : 'Another extra', position: os.length,
                      incentive_kind: null, incentive_label: null, incentive_percent_bp: null,
                      incentive_ex_pennies: null, incentive_vatable: null, incentive_gross_off_pennies: null,
                    }])}>
                    {g.shape === 'pick_one' ? 'Add a choice' : 'Add an extra'}
                  </button>
                  {/* REMOVING THE GROUP RETURNS ITS WORK TO THE MAIN QUOTE — the server does the same
                      for the rows, and doing it here too keeps the screen honest before the save. */}
                  <button type="button" data-testid="remove-group" className="text-sm text-danger ml-auto"
                    onClick={() => {
                      const ids = new Set(mine.map((x) => x.o.id));
                      setLines((ls) => ls.map((x) => (x.option_draft_id && ids.has(x.option_draft_id) ? { ...x, option_draft_id: null } : x)));
                      setOptions((os) => os.filter((o) => o.group_id !== g.id));
                      setGroups((gs) => gs.filter((_, i) => i !== gi));
                    }}>Remove group</button>
                </div>

                {mine.map(({ o, oi }) => (
                  <div key={o.id} className="mt-2 rounded-lg border border-line p-2" data-testid="option-editor"
                    data-option={o.id} data-base={o.is_base ? '1' : undefined}>
                    <div className="flex flex-wrap items-center gap-2">
                      {o.is_base && <span className="text-xs uppercase tracking-wide text-muted">the job</span>}
                      <input className={inputCls} style={{ maxWidth: 220 }} value={o.title} data-testid="option-title"
                        onChange={(e) => setOptions((os) => os.map((x, i) => (i === oi ? { ...x, title: e.target.value } : x)))} />
                      <select className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink" data-testid="option-incentive"
                        value={o.incentive_kind ?? ''}
                        onChange={(e) => {
                          const k = (e.target.value || null) as DraftOption['incentive_kind'];
                          setOptions((os) => os.map((x, i) => (i === oi ? {
                            ...x, incentive_kind: k,
                            incentive_label: k ? (x.incentive_label ?? '') : null,
                            incentive_percent_bp: k === 'percent_off' ? (x.incentive_percent_bp ?? 1000) : null,
                            incentive_ex_pennies: k === 'amount_off' ? (x.incentive_ex_pennies ?? 0) : null,
                            incentive_vatable: k === 'amount_off' ? (x.incentive_vatable ?? true) : null,
                            incentive_gross_off_pennies: k === 'amount_off' ? (x.incentive_gross_off_pennies ?? 0) : null,
                          } : x)));
                        }}>
                        <option value="">no incentive</option>
                        <option value="amount_off">money off</option>
                        <option value="percent_off">a percentage off</option>
                        <option value="included">something included</option>
                      </select>
                      {o.incentive_kind && (
                        <input className={inputCls} style={{ maxWidth: 200 }} data-testid="incentive-label"
                          placeholder="how it reads to the customer" value={o.incentive_label ?? ''}
                          onChange={(e) => setOptions((os) => os.map((x, i) => (i === oi ? { ...x, incentive_label: e.target.value } : x)))} />
                      )}
                      {/* MONEY OFF. The ex-VAT figure the LINE needs and the gross figure the
                          DOCUMENT promises are both frozen, so both are derived here from the one
                          number typed, using this quote's own rate — lib/quote-options refuses a
                          pair that disagrees. */}
                      {o.incentive_kind === 'amount_off' && (
                        <label className="text-xs text-muted flex items-center gap-1">
                          off the total
                          <input className={inputCls} style={{ maxWidth: 100 }} type="number" step="0.01" min="0"
                            data-testid="incentive-amount"
                            value={((o.incentive_gross_off_pennies ?? 0) / 100).toFixed(2)}
                            onChange={(e) => {
                              const gross = Math.max(0, Math.round(Number(e.target.value || 0) * 100));
                              const rate = vatRegistered ? Number(vatRate || 0) : 0;
                              const ex = Math.round(gross / (1 + rate / 100));
                              setOptions((os) => os.map((x, i) => (i === oi
                                ? { ...x, incentive_gross_off_pennies: gross, incentive_ex_pennies: ex, incentive_vatable: rate > 0 }
                                : x)));
                            }} />
                        </label>
                      )}
                      {/* THE RATE, NOT THE MONEY. A draft has no frozen figures to take a percentage
                          of, so the pennies are resolved once at freeze from this option's own lines
                          (lib/quote-version) and never recomputed after. */}
                      {o.incentive_kind === 'percent_off' && (
                        <label className="text-xs text-muted flex items-center gap-1">
                          <input className={inputCls} style={{ maxWidth: 80 }} type="number" min="0.1" max="99" step="0.1"
                            data-testid="incentive-percent"
                            value={((o.incentive_percent_bp ?? 0) / 100).toString()}
                            onChange={(e) => setOptions((os) => os.map((x, i) => (i === oi
                              ? { ...x, incentive_percent_bp: Math.round(Number(e.target.value || 0) * 100) } : x)))} />
                          % off
                        </label>
                      )}
                      <button type="button" data-testid="remove-option" className="text-sm text-danger ml-auto"
                        onClick={() => {
                          setLines((ls) => ls.map((x) => (x.option_draft_id === o.id ? { ...x, option_draft_id: null } : x)));
                          setOptions((os) => os.filter((_, i) => i !== oi));
                        }}>Remove</button>
                    </div>
                    {/* WHICH WORK BELONGS TO IT. Unticked everywhere = the main quote. */}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {lines.length === 0 && <span className="text-xs text-muted">Add some work first, then tick what belongs here.</span>}
                      {lines.map((l) => (
                        <label key={l._uid} className="text-xs text-ink flex items-center gap-1" data-testid="option-line-tick">
                          <input type="checkbox" checked={l.option_draft_id === o.id}
                            onChange={(e) => setLines((ls) => ls.map((x) => (x._uid === l._uid
                              ? { ...x, option_draft_id: e.target.checked ? o.id : null }
                              : x)))} />
                          {l.description || '(untitled line)'}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
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
