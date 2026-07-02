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
import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { computeQuoteTotals, poundsToPennies, QuoteItemType } from '@/lib/quote-totals';
import { resolveTierPrice } from '@/lib/catalogue';
import { formatMoney } from '@/lib/format-money';

export type EstimateLine = {
  item_type: QuoteItemType; // 'labour' | 'part' | 'misc'
  description: string;
  qty: string;        // hours (labour) / quantity (parts)
  unit_price: string; // rate (labour) / unit price (parts; negative allowed)
  unit_cost: string;  // optional cost each
  vatable: boolean;
  code?: string;                    // catalogue code typed on the line (match key; not persisted)
  catalogue_item_id?: string | null; // origin hook, persisted; remembers the catalogue item it came from
};

// Catalogue item (active, tenant-scoped) loaded once for client-side code matching. SIMPLE items only.
export type CatalogueLite = { id: string; code: string; name: string; item_type: QuoteItemType; unit_cost: number; unit_price: number; vat_rate: number };

// Fixed-price services are added via a tier picker (not typed codes). Carries components (spec + cost)
// and per-tier price rows so the explosion resolves the price + spec entirely client-side.
export type FixedServiceLite = {
  id: string; code: string; name: string; basePriceExVat: number; vatRate: number;
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
  initialLines: EstimateLine[];
  vatRegistered?: boolean; // master switch; false → no VAT controls, no VAT in totals
  catalogue?: CatalogueLite[]; // active SIMPLE catalogue for code autocomplete (client-side match)
  fixedServices?: FixedServiceLite[]; // active fixed services for the tier picker
  tiers?: TierLite[]; // active tenant tiers
};

const CODES_DATALIST = 'gd-catalogue-codes';

const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelCls = 'block text-xs text-muted mb-1';

const blank = (item_type: QuoteItemType): Row => ({ _uid: uid(), item_type, description: '', qty: '', unit_price: '', unit_cost: '', vatable: true, code: '', catalogue_item_id: null });

// ---- module-scope row component (stable identity → inputs keep focus) ----
type RowProps = {
  row: Row;
  idx: number;
  kind: 'labour' | 'part';
  canEdit: boolean;
  showVat: boolean;
  hasCatalogue: boolean;
  lineTotal: string;
  t: (k: string) => string;
  onChange: (idx: number, patch: Partial<EstimateLine>) => void;
  onCode: (idx: number, code: string) => void;
  onRemove: (idx: number) => void;
};

function LineRow({ row, idx, kind, canEdit, showVat, hasCatalogue, lineTotal, t, onChange, onCode, onRemove }: RowProps) {
  return (
    <div className="bg-surface-muted border border-line rounded-lg p-3 mb-2 flex flex-col sm:flex-row sm:items-end gap-2">
      {hasCatalogue && (
        <div className="sm:w-28">
          <label className={labelCls}>{t('estimate.code')}</label>
          <input className={inputCls} placeholder={t('estimate.codePlaceholder')} value={row.code ?? ''} list={CODES_DATALIST}
            autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            disabled={!canEdit} onChange={(e) => onCode(idx, e.target.value)} />
        </div>
      )}
      <div className="sm:flex-1">
        <label className={`${labelCls} sm:hidden`}>{t('estimate.description')}</label>
        <textarea className={`${inputCls} resize-y`} rows={2} placeholder={t('estimate.descriptionPlaceholder')} value={row.description}
          disabled={!canEdit} onChange={(e) => onChange(idx, { description: e.target.value })} />
      </div>
      <div className="sm:w-24">
        <label className={labelCls}>{kind === 'labour' ? t('estimate.rate') : t('estimate.unitPrice')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" value={row.unit_price}
          disabled={!canEdit} onChange={(e) => onChange(idx, { unit_price: e.target.value })} />
      </div>
      <div className="sm:w-20">
        <label className={labelCls}>{kind === 'labour' ? t('estimate.hours') : t('estimate.qty')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" value={row.qty}
          disabled={!canEdit} onChange={(e) => onChange(idx, { qty: e.target.value })} />
      </div>
      <div className="sm:w-24">
        <label className={labelCls}>{t('estimate.cost')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" value={row.unit_cost}
          disabled={!canEdit} onChange={(e) => onChange(idx, { unit_cost: e.target.value })} />
      </div>
      {showVat && (
        <label className="flex items-center gap-2 text-sm text-muted sm:w-16 py-2">
          <input type="checkbox" className="w-5 h-5" checked={row.vatable} disabled={!canEdit}
            onChange={(e) => onChange(idx, { vatable: e.target.checked })} />
          {t('estimate.vat')}
        </label>
      )}
      <div className="sm:w-24 text-right">
        <label className={`${labelCls} sm:hidden`}>{t('estimate.lineTotal')}</label>
        <div className="text-ink font-medium tabular-nums py-2">{lineTotal}</div>
      </div>
      {canEdit && (
        <button onClick={() => onRemove(idx)} aria-label={t('estimate.remove')}
          className="text-danger hover:text-danger text-sm px-2 py-2 self-end">✕</button>
      )}
    </div>
  );
}

export default function EstimateBuilder({ jobCardId, canEdit, currency, locale, initialVatRate, initialLines, vatRegistered = true, catalogue = [], fixedServices = [], tiers = [] }: Props) {
  const { t } = useTranslation('jobcard');
  const router = useRouter();
  const [lines, setLines] = useState<Row[]>(() => initialLines.map((l) => ({ ...l, _uid: uid() })));
  const [pickService, setPickService] = useState('');
  const [pickTier, setPickTier] = useState('');

  // Add a fixed-price service: resolve the tier price + spec entirely client-side and explode into
  // ONE line — description = concatenated component spec, unit_price = resolved price (blank when the
  // tier is price-on-the-day), unit_cost = Σ component cost (SILENT — never shown to the customer).
  function addFixedService() {
    const svc = fixedServices.find((s) => s.id === pickService);
    if (!svc) return;
    const res = resolveTierPrice(svc.basePriceExVat, svc.tierPrices, pickTier || null);
    const desc = svc.components.map((c) => c.description).join('\n');
    const costPounds = svc.components.reduce((s, c) => s + Math.max(0, c.qty) * c.unitCost, 0);
    setLines((p) => [...p, {
      _uid: uid(), item_type: 'fixed',
      description: desc || svc.name,
      qty: '1',
      unit_price: res.manual || res.pricePounds == null ? '' : String(res.pricePounds),
      unit_cost: costPounds.toFixed(2),
      vatable: svc.vatRate > 0,
      code: '', catalogue_item_id: svc.id,
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
        unit_cost: String(hit.unit_cost),
        vatable: Number(hit.vat_rate) > 0, // per-line rate maps to the vatable flag; charged at the card rate
        catalogue_item_id: hit.id,
      };
    }));
  };
  const [vatRate, setVatRate] = useState<string>(String(initialVatRate));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const fmt = (pennies: number) => formatMoney(pennies, { currency, locale });

  // Live totals via the shared chokepoint (index-aligned with `lines`).
  const totals = useMemo(
    () => computeQuoteTotals(
      lines.map((l) => ({
        item_type: l.item_type,
        qty: Number(l.qty || 0),
        unit_price_pennies: poundsToPennies(Number(l.unit_price || 0)),
        unit_cost_pennies: poundsToPennies(Number(l.unit_cost || 0)),
        vatable: l.vatable,
      })),
      Number(vatRate || 0),
      { vatRegistered },
    ),
    [lines, vatRate, vatRegistered],
  );

  const update = (idx: number, patch: Partial<EstimateLine>) =>
    setLines((p) => p.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const remove = (idx: number) => setLines((p) => p.filter((_, i) => i !== idx));
  const add = (item_type: QuoteItemType) => setLines((p) => [...p, blank(item_type)]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      // strip the client-only id + the transient code (not a JobCardItem field); keep catalogue_item_id.
      const items = lines.map(({ _uid, code, ...rest }) => rest);
      const res = await fetch('/api/jobcard-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, vatRate: Number(vatRate || 0), items }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('estimate.saveError'), ok: false }); setBusy(false); return; }
      setMsg({ text: t('estimate.saved'), ok: true });
      router.replace(router.asPath); // re-SSR so the persisted card value reflects the save
    } catch {
      setMsg({ text: t('estimate.saveError'), ok: false });
    }
    setBusy(false);
  }

  // Each row carries its original index so per-line totals map back to totals.lines[idx].
  const withIdx = lines.map((l, idx) => ({ l, idx }));
  const labour = withIdx.filter((x) => x.l.item_type === 'labour');
  const parts = withIdx.filter((x) => x.l.item_type !== 'labour' && x.l.item_type !== 'fixed');
  const fixed = withIdx.filter((x) => x.l.item_type === 'fixed'); // published bundles — own section

  return (
    <div className="bg-surface border border-line rounded-xl p-5 mt-6">
      {hasCatalogue && (
        <datalist id={CODES_DATALIST}>
          {catalogue.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
        </datalist>
      )}
      <h2 className="text-lg font-semibold text-ink mb-1">{t('estimate.title')}</h2>
      {!canEdit && <p className="text-warn text-sm mb-3">{t('estimate.readOnly')}</p>}
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

      {/* Labour */}
      <h3 className="text-sm font-semibold text-ink mt-2 mb-2">{t('estimate.labour')}</h3>
      {labour.length === 0 && <p className="text-muted text-sm mb-2">{t('estimate.emptyLabour')}</p>}
      {labour.map(({ l, idx }) => (
        <LineRow key={l._uid} row={l} idx={idx} kind="labour" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={hasCatalogue}
          lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t} onChange={update} onCode={onCode} onRemove={remove} />
      ))}
      {canEdit && <button onClick={() => add('labour')} className="text-xs text-accent hover:underline mb-4">+ {t('estimate.addLabour')}</button>}

      {/* Parts */}
      <h3 className="text-sm font-semibold text-ink mt-4 mb-2">{t('estimate.parts')}</h3>
      {parts.length === 0 && <p className="text-muted text-sm mb-2">{t('estimate.emptyParts')}</p>}
      {parts.map(({ l, idx }) => (
        <LineRow key={l._uid} row={l} idx={idx} kind="part" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={hasCatalogue}
          lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t} onChange={update} onCode={onCode} onRemove={remove} />
      ))}
      {canEdit && (
        <div className="mb-4">
          <button onClick={() => add('part')} className="text-xs text-accent hover:underline">+ {t('estimate.addParts')}</button>
          <p className="text-xs text-muted mt-1">{t('estimate.discountHint')}</p>
        </div>
      )}

      {/* Fixed-price services — published bundles (price-led; cost optional). Shown only if in use
          or the estimate is editable, so it doesn't clutter a card that has none. */}
      {(fixed.length > 0 || canEdit) && (
        <>
          <h3 className="text-sm font-semibold text-ink mt-4 mb-2">{t('estimate.fixed')}</h3>
          {fixed.length === 0 && <p className="text-muted text-sm mb-2">{t('estimate.emptyFixed')}</p>}
          {fixed.map(({ l, idx }) => (
            <LineRow key={l._uid} row={l} idx={idx} kind="part" canEdit={canEdit} showVat={vatRegistered} hasCatalogue={false}
              lineTotal={fmt(totals.lines[idx]?.line_total_pennies ?? 0)} t={t} onChange={update} onCode={onCode} onRemove={remove} />
          ))}
          {canEdit && (
            fixedServices.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2 mb-4">
                <select value={pickService} onChange={(e) => setPickService(e.target.value)} className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink">
                  <option value="">{t('estimate.pickService')}</option>
                  {fixedServices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
        <div className="text-sm space-y-1 sm:w-64">
          <div className="flex justify-between"><span className="text-muted">{t('estimate.summaryLabour')}</span><span className="text-ink tabular-nums">{fmt(totals.labour_pennies)}</span></div>
          <div className="flex justify-between"><span className="text-muted">{t('estimate.summaryParts')}</span><span className="text-ink tabular-nums">{fmt(totals.parts_pennies)}</span></div>
          {vatRegistered && (
            <div className="flex justify-between"><span className="text-muted">{t('estimate.summaryVat')}</span><span className="text-ink tabular-nums">{fmt(totals.vat_pennies)}</span></div>
          )}
          <div className="flex justify-between text-base font-semibold border-t border-line pt-1"><span className="text-ink">{t('estimate.summaryTotal')}</span><span className="text-ink tabular-nums">{fmt(totals.total_pennies)}</span></div>
        </div>
      </div>

      {canEdit && (
        <div className="mt-4">
          <button onClick={save} disabled={busy} className="bg-ok hover:bg-ok text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50 w-full sm:w-auto">
            {busy ? t('estimate.saving') : t('estimate.save')}
          </button>
        </div>
      )}
    </div>
  );
}
