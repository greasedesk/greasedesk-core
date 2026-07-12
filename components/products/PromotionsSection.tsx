/**
 * File: components/products/PromotionsSection.tsx
 * Promotions live WITHIN Products (a promo isn't a product, but it's managed here). A promo is a
 * discount code: FIXED £ (inc-VAT, whole-job) or PERCENTAGE off selected products (multi-select of
 * catalogue items it targets). Applied garage-side on the estimate via "Apply discount code". Admin
 * CRUD against /api/promos; VAT split happens at apply-time (lib/promo). i18n-native, mobile-first.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { formatMoney } from '@/lib/format-money';

type PromoType = 'fixed' | 'percentage';
type Promo = { id: string; code: string; label: string; type: PromoType; amount: number; active: boolean; targets: { id: string; title: string }[] };
type ProductLite = { id: string; code: string; title: string | null; name: string };
type FormState = { id: string | null; code: string; label: string; type: PromoType; amount: string; active: boolean; targetIds: string[] };

const money = (pounds: number) => formatMoney(Math.round((pounds || 0) * 100));
const inputCls = 'mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink';
const labelCls = 'text-sm font-medium text-ink';

export default function PromotionsSection({ products, defaultVatRate, vatRegistered }: {
  products: ProductLite[]; defaultVatRate: number; vatRegistered: boolean;
}) {
  const { t } = useTranslation('promos');
  const [promos, setPromos] = useState<Promo[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const prodLabel = (p: ProductLite) => p.title || p.name || p.code;

  async function load() {
    const res = await fetch('/api/promos');
    if (res.ok) setPromos((await res.json()).promos || []);
  }
  useEffect(() => { load(); }, []);

  const openAdd = () => { setMsg(null); setForm({ id: null, code: '', label: '', type: 'fixed', amount: '', active: true, targetIds: [] }); };
  const openEdit = (p: Promo) => { setMsg(null); setForm({ id: p.id, code: p.code, label: p.label, type: p.type, amount: String(p.amount), active: p.active, targetIds: p.targets.map((t) => t.id) }); };

  const amountNum = Number(form?.amount || 0);
  const canSave = !!form && form.code.trim() !== '' && form.label.trim() !== '' && Number.isFinite(amountNum) && amountNum >= 0
    && (form.type !== 'percentage' || (amountNum <= 100 && form.targetIds.length > 0));

  async function save() {
    if (!form || !canSave) return;
    setBusy(true); setMsg(null);
    const body = { id: form.id || undefined, code: form.code.trim(), label: form.label.trim(), type: form.type, amount: amountNum, active: form.active, targetProductIds: form.type === 'percentage' ? form.targetIds : [] };
    try {
      const res = await fetch('/api/promos', { method: form.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('saveError'), ok: false }); return; }
      setForm(null); setMsg({ text: t('saved'), ok: true }); await load();
    } catch { setMsg({ text: t('saveError'), ok: false }); }
    finally { setBusy(false); } // network throw must never strand the busy flag
  }
  async function toggleActive(p: Promo) { setBusy(true); try { await fetch('/api/promos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, active: !p.active }) }); await load(); } catch { setMsg({ text: t('saveError'), ok: false }); } finally { setBusy(false); } }
  async function hardDelete(p: Promo) { if (!confirm(t('confirmDelete', { code: p.code }))) return; setBusy(true); try { await fetch(`/api/promos?id=${p.id}`, { method: 'DELETE' }); if (form?.id === p.id) setForm(null); await load(); } catch { setMsg({ text: t('saveError'), ok: false }); } finally { setBusy(false); } }

  const toggleTarget = (id: string) => setForm((f) => f && ({ ...f, targetIds: f.targetIds.includes(id) ? f.targetIds.filter((x) => x !== id) : [...f.targetIds, id] }));
  const amountLabel = (p: Promo) => p.type === 'percentage'
    ? `${p.amount}% · ${p.targets.length} ${t('productsWord')}`
    : `${money(p.amount)} ${t('incVat')}${vatRegistered ? ` · ${money(p.amount / (1 + defaultVatRate / 100))} ${t('exVat')}` : ''}`;

  return (
    <details className="bg-surface border border-line rounded-xl p-4 mb-5">
      <summary className="cursor-pointer font-semibold text-ink">{t('heading')} <span className="text-muted font-normal text-sm">({promos.length})</span></summary>
      <p className="text-xs text-muted mt-2">{t('intro')}</p>
      {msg && <div className={`rounded-lg p-2 text-sm my-3 ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

      {/* List */}
      <ul className="mt-3 divide-y divide-line">
        {promos.map((p) => (
          <li key={p.id} className={`flex items-center gap-3 py-2 ${p.active ? '' : 'opacity-60'}`}>
            <span className="font-mono text-xs bg-surface-muted border border-line rounded px-1.5 py-0.5">{p.code}</span>
            <div className="min-w-0 flex-1">
              <div className="text-ink text-sm truncate">{p.label}{!p.active && <span className="ml-2 text-[10px] uppercase text-muted">{t('archived')}</span>}</div>
              <div className="text-xs text-muted">{amountLabel(p)}</div>
            </div>
            <button onClick={() => toggleActive(p)} disabled={busy} className="text-xs text-muted hover:text-ink">{p.active ? t('archive') : t('restore')}</button>
            <button onClick={() => openEdit(p)} className="text-xs text-accent hover:underline">{t('editBtn')}</button>
          </li>
        ))}
        {promos.length === 0 && <li className="text-sm text-muted py-2">{t('empty')}</li>}
      </ul>

      {/* Editor */}
      {form ? (
        <div className="mt-4 border-t border-line pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block"><span className={labelCls}>{t('code')}</span>
              <input value={form.code} placeholder={t('codePlaceholder')} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} autoCapitalize="characters" /></label>
            <label className="block"><span className={labelCls}>{t('label')}</span>
              <input value={form.label} placeholder={t('labelPlaceholder')} onChange={(e) => setForm({ ...form, label: e.target.value })} className={inputCls} /></label>
            <label className="block"><span className={labelCls}>{t('type')}</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as PromoType })} className={inputCls}>
                <option value="fixed">{t('typeFixed')}</option>
                <option value="percentage">{t('typePercentage')}</option>
              </select></label>
            <label className="block"><span className={labelCls}>{form.type === 'percentage' ? t('amountPct') : t('amountFixed')}</span>
              <input type="number" inputMode="decimal" step="0.01" min={0} max={form.type === 'percentage' ? 100 : undefined} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} />
              {form.type === 'fixed' && vatRegistered && amountNum > 0 && <span className="text-xs text-muted">{money(amountNum / (1 + defaultVatRate / 100))} {t('exVat')} · {money(amountNum)} {t('incVat')}</span>}
            </label>
          </div>

          {/* % target products */}
          {form.type === 'percentage' && (
            <div className="mt-3">
              <span className={labelCls}>{t('targets')}</span>
              <p className="text-xs text-muted mb-2">{t('targetsHint')}</p>
              <div className="max-h-48 overflow-y-auto border border-line rounded-lg divide-y divide-line">
                {products.length === 0 && <div className="text-sm text-muted p-2">{t('noProducts')}</div>}
                {products.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 px-2 py-1.5 text-sm text-ink cursor-pointer hover:bg-surface-muted">
                    <input type="checkbox" className="w-4 h-4" checked={form.targetIds.includes(p.id)} onChange={() => toggleTarget(p.id)} />
                    <span className="font-mono text-xs text-muted">{p.code}</span>
                    <span className="truncate">{prodLabel(p)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 mt-3"><input type="checkbox" className="w-5 h-5" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span className={labelCls}>{t('active')}</span></label>
          <div className="flex gap-2 mt-4">
            <button onClick={save} disabled={!canSave || busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? t('saving') : t('save')}</button>
            <button onClick={() => setForm(null)} className="text-muted hover:text-ink px-3 text-sm">{t('cancel')}</button>
            {form.id && <button onClick={() => hardDelete(promos.find((x) => x.id === form.id)!)} disabled={busy} className="ml-auto text-danger hover:bg-danger-soft rounded-lg px-3 py-2 text-sm">{t('delete')}</button>}
          </div>
        </div>
      ) : (
        <button onClick={openAdd} className="mt-3 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-1.5">{t('add')}</button>
      )}
    </details>
  );
}
