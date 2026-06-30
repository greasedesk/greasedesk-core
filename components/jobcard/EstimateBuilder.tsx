/**
 * File: components/jobcard/EstimateBuilder.tsx
 * Staff-side quote/estimate builder. Labour + parts line tables, per-line VAT toggle, editable
 * per-quote VAT rate, negative prices allowed (discount lines). Live totals come from the shared
 * pure chokepoint lib/quote-totals.ts (same maths the API persists); money via formatMoney.
 * Mobile-first: each line is a stacked touch card on a phone, an aligned row at sm+.
 * Read-only when the viewer can't edit pricing (STANDARD).
 */
import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { computeQuoteTotals, poundsToPennies, QuoteItemType } from '@/lib/quote-totals';
import { formatMoney } from '@/lib/format-money';

export type EstimateLine = {
  item_type: QuoteItemType; // 'labour' | 'part' (misc supported by the API; not surfaced this slice)
  description: string;
  qty: string;        // hours (labour) / quantity (parts)
  unit_price: string; // rate (labour) / unit price (parts; negative allowed)
  unit_cost: string;  // optional cost each
  vatable: boolean;
};

type Props = {
  jobCardId: string;
  canEdit: boolean;
  currency: string;
  locale: string;
  initialVatRate: number;
  initialLines: EstimateLine[];
};

const inputCls = 'w-full p-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm focus:ring-blue-500 focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

const blank = (item_type: QuoteItemType): EstimateLine => ({ item_type, description: '', qty: '', unit_price: '', unit_cost: '', vatable: true });

export default function EstimateBuilder({ jobCardId, canEdit, currency, locale, initialVatRate, initialLines }: Props) {
  const { t } = useTranslation('jobcard');
  const router = useRouter();
  const [lines, setLines] = useState<EstimateLine[]>(initialLines);
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
    ),
    [lines, vatRate],
  );

  const update = (idx: number, patch: Partial<EstimateLine>) =>
    setLines((p) => p.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const remove = (idx: number) => setLines((p) => p.filter((_, i) => i !== idx));
  const add = (item_type: QuoteItemType) => setLines((p) => [...p, blank(item_type)]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/jobcard-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, vatRate: Number(vatRate || 0), items: lines }),
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

  // Each line carries its original index so per-line totals map back to totals.lines[idx].
  const withIdx = lines.map((l, idx) => ({ l, idx }));
  const labour = withIdx.filter((x) => x.l.item_type === 'labour');
  const parts = withIdx.filter((x) => x.l.item_type !== 'labour');

  const LineCard = ({ l, idx, kind }: { l: EstimateLine; idx: number; kind: 'labour' | 'part' }) => (
    <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-3 mb-2 flex flex-col sm:flex-row sm:items-end gap-2">
      <div className="sm:flex-1">
        <label className={`${labelCls} sm:hidden`}>{t('estimate.description')}</label>
        <input className={inputCls} placeholder={t('estimate.descriptionPlaceholder')} value={l.description}
          disabled={!canEdit} onChange={(e) => update(idx, { description: e.target.value })} />
      </div>
      <div className="sm:w-24">
        <label className={labelCls}>{kind === 'labour' ? t('estimate.rate') : t('estimate.unitPrice')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" value={l.unit_price}
          disabled={!canEdit} onChange={(e) => update(idx, { unit_price: e.target.value })} />
      </div>
      <div className="sm:w-20">
        <label className={labelCls}>{kind === 'labour' ? t('estimate.hours') : t('estimate.qty')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" value={l.qty}
          disabled={!canEdit} onChange={(e) => update(idx, { qty: e.target.value })} />
      </div>
      <div className="sm:w-24">
        <label className={labelCls}>{t('estimate.cost')}</label>
        <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" value={l.unit_cost}
          disabled={!canEdit} onChange={(e) => update(idx, { unit_cost: e.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300 sm:w-16 py-2">
        <input type="checkbox" className="w-5 h-5" checked={l.vatable} disabled={!canEdit}
          onChange={(e) => update(idx, { vatable: e.target.checked })} />
        {t('estimate.vat')}
      </label>
      <div className="sm:w-24 text-right">
        <label className={`${labelCls} sm:hidden`}>{t('estimate.lineTotal')}</label>
        <div className="text-white font-medium tabular-nums py-2">{fmt(totals.lines[idx]?.line_total_pennies ?? 0)}</div>
      </div>
      {canEdit && (
        <button onClick={() => remove(idx)} aria-label={t('estimate.remove')}
          className="text-red-400 hover:text-red-300 text-sm px-2 py-2 self-end">✕</button>
      )}
    </div>
  );

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 mt-6">
      <h2 className="text-lg font-semibold text-white mb-1">{t('estimate.title')}</h2>
      {!canEdit && <p className="text-amber-300 text-sm mb-3">{t('estimate.readOnly')}</p>}
      {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}>{msg.text}</div>}

      {/* Labour */}
      <h3 className="text-sm font-semibold text-slate-200 mt-2 mb-2">{t('estimate.labour')}</h3>
      {labour.length === 0 && <p className="text-slate-500 text-sm mb-2">{t('estimate.emptyLabour')}</p>}
      {labour.map(({ l, idx }) => <LineCard key={idx} l={l} idx={idx} kind="labour" />)}
      {canEdit && <button onClick={() => add('labour')} className="text-xs text-blue-400 hover:underline mb-4">+ {t('estimate.addLabour')}</button>}

      {/* Parts */}
      <h3 className="text-sm font-semibold text-slate-200 mt-4 mb-2">{t('estimate.parts')}</h3>
      {parts.length === 0 && <p className="text-slate-500 text-sm mb-2">{t('estimate.emptyParts')}</p>}
      {parts.map(({ l, idx }) => <LineCard key={idx} l={l} idx={idx} kind="part" />)}
      {canEdit && (
        <div className="mb-4">
          <button onClick={() => add('part')} className="text-xs text-blue-400 hover:underline">+ {t('estimate.addParts')}</button>
          <p className="text-xs text-slate-500 mt-1">{t('estimate.discountHint')}</p>
        </div>
      )}

      {/* VAT rate + summary */}
      <div className="border-t border-slate-700 mt-4 pt-4 flex flex-col sm:flex-row sm:justify-between gap-4">
        <div className="sm:w-40">
          <label className={labelCls}>{t('estimate.vatRate')}</label>
          <input className={inputCls} type="number" inputMode="decimal" step="0.01" min="0" max="100" value={vatRate}
            disabled={!canEdit} onChange={(e) => setVatRate(e.target.value)} />
        </div>
        <div className="text-sm space-y-1 sm:w-64">
          <div className="flex justify-between"><span className="text-slate-400">{t('estimate.summaryLabour')}</span><span className="text-slate-100 tabular-nums">{fmt(totals.labour_pennies)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">{t('estimate.summaryParts')}</span><span className="text-slate-100 tabular-nums">{fmt(totals.parts_pennies)}</span></div>
          <div className="flex justify-between"><span className="text-slate-400">{t('estimate.summaryVat')}</span><span className="text-slate-100 tabular-nums">{fmt(totals.vat_pennies)}</span></div>
          <div className="flex justify-between text-base font-semibold border-t border-slate-700 pt-1"><span className="text-white">{t('estimate.summaryTotal')}</span><span className="text-white tabular-nums">{fmt(totals.total_pennies)}</span></div>
        </div>
      </div>

      {canEdit && (
        <div className="mt-4">
          <button onClick={save} disabled={busy} className="bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50 w-full sm:w-auto">
            {busy ? t('estimate.saving') : t('estimate.save')}
          </button>
        </div>
      )}
    </div>
  );
}
