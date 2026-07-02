/**
 * File: pages/admin/products/index.tsx
 * Products (catalogue) — ADMIN/owner only. Define regular parts/labour/bundles once (code → cost,
 * price, VAT, type) so a job-card line autocompletes from the code. CRUD via /api/catalogue.
 * Archive (active=false) is the primary "remove" (preserves history); hard delete is available.
 * i18n-native, formatMoney, mobile-first.
 */
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';

type ItemType = 'labour' | 'part' | 'misc' | 'fixed';
type Item = { id: string; code: string; name: string; itemType: ItemType; unitCost: number; unitPrice: number; vatRate: number; active: boolean };
type FormState = { id: string | null; code: string; name: string; itemType: ItemType; cost: string; price: string; vatRate: string; active: boolean };

const money = (pounds: number) => formatMoney(Math.round((pounds || 0) * 100));
const inputCls = 'mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink';
const labelCls = 'text-sm font-medium text-ink';

export default function ProductsPage() {
  const { t } = useTranslation('products');
  const [items, setItems] = useState<Item[]>([]);
  const [defaultVatRate, setDefaultVatRate] = useState('20');
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    const res = await fetch('/api/catalogue');
    if (!res.ok) return;
    const data = await res.json();
    setItems(data.items || []);
    if (data.defaultVatRate != null) setDefaultVatRate(String(data.defaultVatRate));
  }
  useEffect(() => { load(); }, []);

  const openAdd = () => { setMsg(null); setForm({ id: null, code: '', name: '', itemType: 'part', cost: '', price: '', vatRate: defaultVatRate, active: true }); };
  const openEdit = (i: Item) => { setMsg(null); setForm({ id: i.id, code: i.code, name: i.name, itemType: i.itemType, cost: String(i.unitCost), price: String(i.unitPrice), vatRate: String(i.vatRate), active: i.active }); };
  const close = () => setForm(null);

  // Cost is optional for fixed-price bundles (price-led; true cost accrues on the real job lines).
  const canSave = !!form && form.code.trim() !== '' && form.name.trim() !== '' && form.price !== ''
    && (form.itemType === 'fixed' || (form.cost !== '' && Number(form.cost) >= 0));

  async function save() {
    if (!form || !canSave) return;
    setBusy(true); setMsg(null);
    const body = {
      id: form.id || undefined, code: form.code.trim(), name: form.name.trim(), itemType: form.itemType,
      unitCost: Number(form.cost), unitPrice: Number(form.price), vatRate: Number(form.vatRate || 0), active: form.active,
    };
    try {
      const res = await fetch('/api/catalogue', { method: form.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); setBusy(false); return; }
      await load(); setForm(null); setMsg({ text: t('saved'), ok: true });
    } catch { setMsg({ text: t('error'), ok: false }); }
    setBusy(false);
  }

  async function setActive(i: Item, active: boolean) {
    setBusy(true);
    try { const res = await fetch('/api/catalogue', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i.id, active }) }); if (res.ok) await load(); } finally { setBusy(false); }
  }
  async function hardDelete(i: Item) {
    if (!confirm(t('confirmDelete'))) return;
    setBusy(true);
    try { const res = await fetch(`/api/catalogue?id=${encodeURIComponent(i.id)}`, { method: 'DELETE' }); if (res.ok) { await load(); setForm(null); } } finally { setBusy(false); }
  }

  const typeLabel = (ty: ItemType) => t(ty);
  const shown = items.filter((i) => showArchived || i.active);

  return (
    <>
      <Head><title>Products - GreaseDesk</title></Head>
      <div className="max-w-3xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-3xl font-bold text-ink">{t('title')}</h1>
            <p className="text-sm text-muted mt-1 max-w-xl">{t('intro')}</p>
          </div>
          {!form && <button onClick={openAdd} className="shrink-0 bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm">{t('add')}</button>}
        </div>

        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        {form && (
          <div className="bg-surface border border-line rounded-xl p-4 sm:p-6 mb-5">
            <h2 className="font-semibold text-ink mb-3">{form.id ? t('edit') : t('add')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className={labelCls}>{t('code')}</span>
                <input value={form.code} placeholder={t('codePlaceholder')} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} /></label>
              <label className="block"><span className={labelCls}>{t('type')}</span>
                <select value={form.itemType} onChange={(e) => setForm({ ...form, itemType: e.target.value as ItemType })} className={inputCls}>
                  <option value="part">{t('part')}</option><option value="labour">{t('labour')}</option><option value="fixed">{t('fixed')}</option><option value="misc">{t('misc')}</option>
                </select></label>
              <label className="block sm:col-span-2"><span className={labelCls}>{t('name')}</span>
                <input value={form.name} placeholder={t('namePlaceholder')} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></label>
              <label className="block"><span className={labelCls}>{t('cost')}</span>
                <input type="number" inputMode="decimal" step="0.01" min={0} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className={inputCls} /></label>
              <label className="block"><span className={labelCls}>{t('price')}</span>
                <input type="number" inputMode="decimal" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={inputCls} /></label>
              <label className="block"><span className={labelCls}>{t('vatRate')}</span>
                <input type="number" inputMode="decimal" step="0.01" min={0} max={100} value={form.vatRate} onChange={(e) => setForm({ ...form, vatRate: e.target.value })} className={inputCls} /></label>
              <label className="flex items-center gap-2 pt-6"><input type="checkbox" className="w-5 h-5" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span className={labelCls}>{t('active')}</span></label>
            </div>
            {form.cost !== '' && form.price !== '' && (
              <p className="text-xs text-muted mt-2">{t('margin')}: <span className="text-ink font-medium">{money(Number(form.price) - Number(form.cost))}</span></p>
            )}
            <div className="mt-5 flex items-center gap-2">
              <button onClick={save} disabled={busy || !canSave} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? t('saving') : t('save')}</button>
              <button onClick={close} className="text-muted hover:text-ink rounded-lg px-4 py-2 text-sm">{t('cancel')}</button>
              {form.id && <button onClick={() => hardDelete(items.find((x) => x.id === form.id)!)} disabled={busy} className="ml-auto text-danger hover:bg-danger-soft rounded-lg px-3 py-2 text-sm">{t('delete')}</button>}
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-muted mb-3">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {t('showArchived')}
        </label>

        {shown.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
            {shown.map((i) => (
              <li key={i.id} className={`flex flex-wrap items-center gap-3 p-3 bg-surface ${i.active ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-ink font-medium truncate">
                    <span className="font-mono text-xs bg-surface-muted border border-line rounded px-1.5 py-0.5 mr-2">{i.code}</span>
                    {i.name}
                    {!i.active && <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">{t('archived')}</span>}
                  </div>
                  <div className="text-xs text-muted mt-0.5">{typeLabel(i.itemType)} · {t('cost')} {money(i.unitCost)} · {t('price')} {money(i.unitPrice)} · {t('margin')} {money(i.unitPrice - i.unitCost)} · {t('vatRate')} {i.vatRate}%</div>
                </div>
                <button onClick={() => openEdit(i)} className="text-sm text-accent hover:underline">{t('edit')}</button>
                {i.active
                  ? <button onClick={() => setActive(i, false)} disabled={busy} className="text-sm text-muted hover:text-ink">{t('archive')}</button>
                  : <button onClick={() => setActive(i, true)} disabled={busy} className="text-sm text-accent hover:underline">{t('restore')}</button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['products'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
});
