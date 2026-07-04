/**
 * File: pages/admin/promos/index.tsx
 * Promotions — reusable VAT-aware discount codes (ADMIN/owner only). A promo is entered INC-VAT (a
 * fixed "£50 off" or a "10% off") and applied on an estimate as a negative discount line, VAT split by
 * lib/promo.ts. Not sellable — its own section, distinct from Products. i18n-native, formatMoney,
 * mobile-first.
 */
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';

type PromoType = 'fixed' | 'percentage';
type Promo = { id: string; code: string; label: string; type: PromoType; amount: number; active: boolean };
type FormState = { id: string | null; code: string; label: string; type: PromoType; amount: string; active: boolean };

const money = (pounds: number) => formatMoney(Math.round((pounds || 0) * 100));
const inc = (exPounds: number, rate: number) => exPounds * (1 + (rate || 0) / 100);
const inputCls = 'mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink';
const labelCls = 'text-sm font-medium text-ink';

export default function PromosPage() {
  const { t } = useTranslation('promos');
  const [promos, setPromos] = useState<Promo[]>([]);
  const [defaultVatRate, setDefaultVatRate] = useState(20);
  const [vatRegistered, setVatRegistered] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    const res = await fetch('/api/promos');
    if (!res.ok) return;
    const data = await res.json();
    setPromos(data.promos || []);
    setVatRegistered(!!data.vatRegistered);
    if (data.defaultVatRate != null) setDefaultVatRate(Number(data.defaultVatRate));
  }
  useEffect(() => { load(); }, []);

  const openAdd = () => { setMsg(null); setForm({ id: null, code: '', label: '', type: 'fixed', amount: '', active: true }); };
  const openEdit = (p: Promo) => { setMsg(null); setForm({ id: p.id, code: p.code, label: p.label, type: p.type, amount: String(p.amount), active: p.active }); };

  const amountNum = Number(form?.amount || 0);
  const canSave = !!form && form.code.trim() !== '' && form.label.trim() !== '' && Number.isFinite(amountNum) && amountNum >= 0
    && (form.type !== 'percentage' || amountNum <= 100);

  async function save() {
    if (!form || !canSave) return;
    setBusy(true); setMsg(null);
    const body = { id: form.id || undefined, code: form.code.trim(), label: form.label.trim(), type: form.type, amount: amountNum, active: form.active };
    const res = await fetch('/api/promos', { method: form.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ text: data?.message || t('saveError'), ok: false }); return; }
    setForm(null); setMsg({ text: t('saved'), ok: true }); await load();
  }

  async function toggleActive(p: Promo) {
    setBusy(true);
    await fetch('/api/promos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, active: !p.active }) });
    setBusy(false); await load();
  }
  async function hardDelete(p: Promo) {
    if (!confirm(t('confirmDelete', { code: p.code }))) return;
    setBusy(true);
    await fetch(`/api/promos?id=${p.id}`, { method: 'DELETE' });
    setBusy(false); if (form?.id === p.id) setForm(null); await load();
  }

  const shown = promos.filter((p) => showArchived || p.active);
  const amountLabel = (p: Promo) => p.type === 'percentage'
    ? `${p.amount}%`
    : `${money(p.amount)} ${t('incVat')}${vatRegistered ? ` · ${money(p.amount / (1 + defaultVatRate / 100))} ${t('exVat')}` : ''}`;

  return (
    <>
      <Head><title>Promotions - GreaseDesk</title></Head>
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold text-ink">{t('title')}</h1>
          {!form && <button onClick={openAdd} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm">{t('add')}</button>}
        </div>
        <p className="text-sm text-muted mb-5">{t('intro')}</p>
        {msg && <div className={`rounded-lg p-2.5 text-sm mb-4 ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        {/* Editor */}
        {form && (
          <div className="bg-surface border border-line rounded-xl p-5 mb-6">
            <h2 className="font-semibold text-ink mb-3">{form.id ? t('edit') : t('add')}</h2>
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
                {form.type === 'fixed' && vatRegistered && amountNum > 0 && (
                  <span className="text-xs text-muted">{money(amountNum / (1 + defaultVatRate / 100))} {t('exVat')} · {money(amountNum)} {t('incVat')}</span>
                )}
                {form.type === 'percentage' && <span className="text-xs text-muted">{t('pctHint')}</span>}
              </label>
            </div>
            <label className="flex items-center gap-2 mt-3"><input type="checkbox" className="w-5 h-5" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span className={labelCls}>{t('active')}</span></label>
            <div className="flex gap-2 mt-4">
              <button onClick={save} disabled={!canSave || busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? t('saving') : t('save')}</button>
              <button onClick={() => setForm(null)} className="text-muted hover:text-ink px-3 text-sm">{t('cancel')}</button>
              {form.id && <button onClick={() => hardDelete(promos.find((x) => x.id === form.id)!)} disabled={busy} className="ml-auto text-danger hover:bg-danger-soft rounded-lg px-3 py-2 text-sm">{t('delete')}</button>}
            </div>
          </div>
        )}

        {/* List */}
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-ink">{t('listTitle')}</h2>
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />{t('showArchived')}</label>
        </div>
        {shown.length === 0 ? (
          <div className="bg-surface-muted border border-line rounded-xl p-8 text-center text-muted">{t('empty')}</div>
        ) : (
          <div className="bg-surface border border-line rounded-xl overflow-hidden">
            {shown.map((p) => (
              <div key={p.id} className={`flex items-center gap-3 px-4 py-3 border-t border-line first:border-t-0 ${!p.active ? 'opacity-60' : ''}`}>
                <span className="font-mono text-xs bg-surface-muted border border-line rounded px-1.5 py-0.5">{p.code}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-ink text-sm truncate">{p.label}{!p.active && <span className="ml-2 text-[10px] uppercase text-muted">{t('archived')}</span>}</div>
                  <div className="text-xs text-muted">{amountLabel(p)}</div>
                </div>
                <button onClick={() => toggleActive(p)} disabled={busy} className="text-xs text-muted hover:text-ink px-2">{p.active ? t('archive') : t('restore')}</button>
                <button onClick={() => openEdit(p)} className="text-sm text-accent hover:underline">{t('editBtn')}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['promos'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
});
