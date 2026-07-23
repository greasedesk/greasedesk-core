/**
 * File: pages/admin/settings/overheads.tsx
 * Settings → Overheads (ADMIN/owner only). Open-ended business costs with per-site allocation,
 * organised BY SITE — a shared cost shows under each site it's allocated to (with that site's %).
 * All values come only from the admin-gated /api/overheads; nothing leaks to other roles.
 * Store-only (no aggregation). Light theme, mobile-first.
 */
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';
import { displayCurrency } from '@/lib/display-currency';
import AllocationEditor, { AllocRow, allocIsValid } from '@/components/settings/AllocationEditor';

type SiteOpt = { id: string; name: string; isActive: boolean };
type Alloc = { siteId: string; percent: number };
type Period = 'weekly' | 'monthly' | 'annual';
type Overhead = { id: string; name: string; exVatPennies: number; vatRate: number; vatPennies: number; grossPennies: number; period: Period; isActive: boolean; allocations: Alloc[] };

type FormState = { id: string | null; name: string; exVat: string; vatRate: string; period: Period; rows: AllocRow[] };

const poundsToPennies = (s: string): number => Math.round((Number(s) || 0) * 100);
const penniesToInput = (p: number): string => (p / 100).toFixed(2);
const clampRate = (r: number) => Math.min(100, Math.max(0, Number.isFinite(r) ? r : 0));

export default function OverheadsSettings({ currency, locale }: { currency: string; locale: string }) {
  const money = (p: number) => formatMoney(p, { currency, locale });
  const { t } = useTranslation('overheads');
  const router = useRouter();
  const [sites, setSites] = useState<SiteOpt[]>([]);
  const [overheads, setOverheads] = useState<Overhead[]>([]);
  const [vatRegistered, setVatRegistered] = useState(true);
  const [defaultVatRate, setDefaultVatRate] = useState('20');
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const res = await fetch('/api/overheads');
    if (!res.ok) return;
    const data = await res.json();
    setSites(data.sites || []);
    setOverheads(data.overheads || []);
    setVatRegistered(!!data.vatRegistered);
    if (data.defaultVatRate != null) setDefaultVatRate(String(data.defaultVatRate));
    setLoaded(true);
  }
  useEffect(() => { load(); }, []);
  // Guided-setup walkthrough: auto-open the add form on arrival (item-13). After load so the VAT
  // prefill is correct. openOnce guards against re-opening.
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (loaded && !autoOpened && router.query.add === '1') { setAutoOpened(true); openAdd(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, router.query.add]);

  // New overhead pre-fills the VAT rate from the company default (editable per-expense).
  function openAdd() { setMsg(null); setForm({ id: null, name: '', exVat: '', vatRate: vatRegistered ? defaultVatRate : '0', period: 'monthly', rows: [] }); }
  function openEdit(o: Overhead) {
    setMsg(null);
    setForm({
      id: o.id, name: o.name, exVat: penniesToInput(o.exVatPennies), vatRate: String(o.vatRate), period: o.period,
      rows: o.allocations.map((a, i) => ({ key: `${a.siteId}-${i}`, siteId: a.siteId, percent: String(a.percent) })),
    });
  }
  function close() { setForm(null); }

  const canSave = !!form && form.name.trim() !== '' && Number(form.exVat) >= 0 && form.exVat !== '' && allocIsValid(form.rows);

  async function save() {
    if (!form || !canSave) return;
    setBusy(true); setMsg(null);
    const body = {
      id: form.id || undefined,
      name: form.name.trim(), period: form.period, exVatAmountPennies: poundsToPennies(form.exVat),
      vatRate: vatRegistered ? clampRate(Number(form.vatRate)) : 0,
      allocations: form.rows.map((r) => ({ siteId: r.siteId, percent: Number(r.percent) })),
    };
    try {
      const res = await fetch('/api/overheads', {
        method: form.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); setBusy(false); return; }
      // Guided-setup walkthrough: return to the sequence so it advances (item-13).
      if (router.query.setup === '1') { router.push('/admin/setup?walk=1'); return; }
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
    // Ex-VAT is the true cost. When registered with a rate, also show VAT + gross.
    if (vatRegistered && o.vatPennies > 0) {
      return `${money(o.exVatPennies)} ${t('exVat')} + ${money(o.vatPennies)} ${t('vatAt', { rate: o.vatRate })} = ${money(o.grossPennies)} · ${t(o.period)}`;
    }
    return `${money(o.exVatPennies)} · ${t(o.period)}`;
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
                <span className="text-sm font-medium text-ink">{vatRegistered ? t('exVatAmount') : t('amount')}</span>
                <input type="number" inputMode="decimal" min={0} step="0.01" value={form.exVat}
                  onChange={(e) => setForm({ ...form, exVat: e.target.value })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
              </label>
              {vatRegistered && (
                <label className="block">
                  <span className="text-sm font-medium text-ink">{t('vatRate')}</span>
                  <input type="number" inputMode="decimal" min={0} max={100} step="0.01" value={form.vatRate}
                    onChange={(e) => setForm({ ...form, vatRate: e.target.value })}
                    className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
                  <span className="text-xs text-muted mt-0.5 block">{t('vatRateHint')}</span>
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

            {vatRegistered && (() => {
              const exP = poundsToPennies(form.exVat);
              const vatP = Math.round((exP * clampRate(Number(form.vatRate))) / 100);
              return (
                <p className="text-xs text-muted mt-2">
                  {t('vatCalc', { vat: money(vatP), gross: money(exP + vatP) })}
                </p>
              );
            })()}

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
  return { props: { ...(await displayCurrency(gate.vis.primarySiteId)) } };
});
