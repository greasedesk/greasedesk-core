/**
 * File: pages/admin/settings/overheads.tsx
 * Settings → Overheads (ADMIN/owner only). Open-ended business costs with per-site allocation,
 * organised BY SITE — a shared cost shows under each site it's allocated to (with that site's %).
 * All values come only from the admin-gated /api/overheads; nothing leaks to other roles.
 * Store-only (no aggregation). Light theme, mobile-first.
 */
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';
import AllocationEditor, { AllocRow, allocIsValid } from '@/components/settings/AllocationEditor';

type SiteOpt = { id: string; name: string; isActive: boolean };
type Alloc = { siteId: string; percent: number };
type Period = 'weekly' | 'monthly' | 'annual';
type Overhead = { id: string; name: string; amountPennies: number; vatAmountPennies: number; period: Period; isActive: boolean; allocations: Alloc[] };

type FormState = { id: string | null; name: string; amount: string; vatAmount: string; period: Period; rows: AllocRow[] };

const emptyForm = (): FormState => ({ id: null, name: '', amount: '', vatAmount: '', period: 'monthly', rows: [] });
const poundsToPennies = (s: string): number => Math.round((Number(s) || 0) * 100);
const penniesToInput = (p: number): string => (p / 100).toFixed(2);

export default function OverheadsSettings() {
  const { t } = useTranslation('overheads');
  const [sites, setSites] = useState<SiteOpt[]>([]);
  const [overheads, setOverheads] = useState<Overhead[]>([]);
  const [vatRegistered, setVatRegistered] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    const res = await fetch('/api/overheads');
    if (!res.ok) return;
    const data = await res.json();
    setSites(data.sites || []);
    setOverheads(data.overheads || []);
    setVatRegistered(!!data.vatRegistered);
  }
  useEffect(() => { load(); }, []);

  function openAdd() { setMsg(null); setForm(emptyForm()); }
  function openEdit(o: Overhead) {
    setMsg(null);
    setForm({
      id: o.id, name: o.name, amount: penniesToInput(o.amountPennies),
      vatAmount: o.vatAmountPennies ? penniesToInput(o.vatAmountPennies) : '', period: o.period,
      rows: o.allocations.map((a, i) => ({ key: `${a.siteId}-${i}`, siteId: a.siteId, percent: String(a.percent) })),
    });
  }
  function close() { setForm(null); }

  const canSave = !!form && form.name.trim() !== '' && Number(form.amount) >= 0 && form.amount !== '' && allocIsValid(form.rows);

  async function save() {
    if (!form || !canSave) return;
    setBusy(true); setMsg(null);
    const body = {
      id: form.id || undefined,
      name: form.name.trim(), period: form.period, amountPennies: poundsToPennies(form.amount),
      vatAmountPennies: vatRegistered ? poundsToPennies(form.vatAmount) : 0,
      allocations: form.rows.map((r) => ({ siteId: r.siteId, percent: Number(r.percent) })),
    };
    try {
      const res = await fetch('/api/overheads', {
        method: form.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); setBusy(false); return; }
      await load(); setForm(null); setMsg({ text: t('saved'), ok: true });
    } catch { setMsg({ text: t('error'), ok: false }); }
    setBusy(false);
  }

  async function remove(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/overheads?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) { await load(); setForm(null); }
    } finally { setBusy(false); }
  }

  const amountLabel = (o: Overhead) => {
    const base = `${formatMoney(o.amountPennies)} · ${t(o.period)}`;
    // When registered with a VAT component, show the true (ex-VAT reclaimable) cost.
    if (vatRegistered && o.vatAmountPennies > 0) {
      return `${base} · ${formatMoney(o.amountPennies - o.vatAmountPennies)} ${t('exVat')}`;
    }
    return base;
  };

  return (
    <SettingsLayout isAdmin>
      <Head><title>Overheads - GreaseDesk</title></Head>
      <div className="max-w-3xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{t('title')}</h2>
            <p className="text-sm text-muted mt-0.5">{t('intro')}</p>
          </div>
          {!form && (
            <button onClick={openAdd} className="shrink-0 bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm">
              {t('add')}
            </button>
          )}
        </div>

        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        {form && (
          <div className="bg-surface border border-line rounded-xl p-4 sm:p-6 mb-5">
            <h3 className="font-semibold text-ink mb-3">{form.id ? t('edit') : t('add')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="text-sm font-medium text-ink">{t('name')}</span>
                <input value={form.name} placeholder={t('namePlaceholder')} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-ink">{vatRegistered ? t('amountGross') : t('amount')}</span>
                <input type="number" inputMode="decimal" min={0} step="0.01" value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
              </label>
              {vatRegistered && (
                <label className="block">
                  <span className="flex items-center justify-between text-sm font-medium text-ink">
                    {t('vatAmount')}
                    <button type="button" onClick={() => setForm({ ...form, vatAmount: (Number(form.amount || 0) / 6).toFixed(2) })}
                      className="text-xs text-accent hover:underline font-normal">{t('vatDerive')}</button>
                  </span>
                  <input type="number" inputMode="decimal" min={0} step="0.01" value={form.vatAmount}
                    onChange={(e) => setForm({ ...form, vatAmount: e.target.value })}
                    className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
                  <span className="text-xs text-muted mt-0.5 block">{t('vatHint')}</span>
                </label>
              )}
              <label className="block">
                <span className="text-sm font-medium text-ink">{t('period')}</span>
                <select value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value as Period })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink">
                  <option value="weekly">{t('weekly')}</option>
                  <option value="monthly">{t('monthly')}</option>
                  <option value="annual">{t('annual')}</option>
                </select>
              </label>
            </div>

            <AllocationEditor sites={sites} rows={form.rows} onChange={(rows) => setForm({ ...form, rows })} t={t} />

            <div className="mt-5 flex items-center gap-2">
              <button onClick={save} disabled={busy || !canSave}
                className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
                {busy ? t('saving') : t('save')}
              </button>
              <button onClick={close} className="text-muted hover:text-ink rounded-lg px-4 py-2 text-sm">{t('cancel')}</button>
              {form.id && (
                <button onClick={() => remove(form.id!)} disabled={busy}
                  className="ml-auto text-danger hover:bg-danger-soft rounded-lg px-3 py-2 text-sm">{t('delete')}</button>
              )}
            </div>
          </div>
        )}

        <div className="space-y-5">
          {sites.map((site) => {
            const here = overheads.filter((o) => o.allocations.some((a) => a.siteId === site.id));
            return (
              <div key={site.id}>
                <h3 className="text-sm font-semibold text-ink uppercase tracking-wide mb-2">{site.name}</h3>
                {here.length === 0 ? (
                  <p className="text-sm text-muted">{t('emptySite')}</p>
                ) : (
                  <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
                    {here.map((o) => {
                      const share = o.allocations.find((a) => a.siteId === site.id)!;
                      const shared = o.allocations.length > 1;
                      return (
                        <li key={o.id} className="flex items-center gap-3 p-3 bg-surface">
                          <div className="min-w-0 flex-1">
                            <div className="text-ink font-medium truncate">{o.name}</div>
                            <div className="text-xs text-muted">{amountLabel(o)}</div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-ink font-semibold text-sm">{share.percent}%</div>
                            {shared && <span className="text-[10px] uppercase tracking-wide text-accent">{t('shared')}</span>}
                          </div>
                          <button onClick={() => openEdit(o)} className="shrink-0 text-sm text-accent hover:underline">{t('edit')}</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
          {overheads.length === 0 && sites.length > 0 && <p className="text-sm text-muted">{t('empty')}</p>}
        </div>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['overheads'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
});
