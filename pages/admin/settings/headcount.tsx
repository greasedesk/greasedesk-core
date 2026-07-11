/**
 * File: pages/admin/settings/headcount.tsx
 * Settings → Headcount (ADMIN/owner only). People-as-costs with per-site allocation, organised
 * BY SITE — a shared person shows under each site they're allocated to (with that site's %).
 * All values come only from the admin-gated /api/headcount; nothing leaks to other roles.
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
import { rosteredWeekdays } from '@/lib/rostered-days';

type SiteOpt = { id: string; name: string; isActive: boolean; openDays?: number[] };
type Alloc = { siteId: string; percent: number };
type Person = {
  id: string; name: string; role: string | null; costType: 'salary' | 'hourly'; amountPennies: number; isActive: boolean;
  isChargeable: boolean; contractedHoursPerDay: number | null; workingDays: number[];
  allocations: Alloc[];
};

type FormState = {
  id: string | null; name: string; role: string; costType: 'salary' | 'hourly'; amount: string; rows: AllocRow[];
  isChargeable: boolean; contractedHours: string; workingDays: number[];
};

const emptyForm = (): FormState => ({ id: null, name: '', role: '', costType: 'salary', amount: '', rows: [], isChargeable: false, contractedHours: '', workingDays: [] });
// Display order Mon..Sun; values are the storage convention 0=Sun..6=Sat.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const poundsToPennies = (s: string): number => Math.round((Number(s) || 0) * 100);
const penniesToInput = (p: number): string => (p / 100).toFixed(2);

export default function HeadcountSettings() {
  const { t } = useTranslation('headcount');
  const [sites, setSites] = useState<SiteOpt[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    const res = await fetch('/api/headcount');
    if (!res.ok) return;
    const data = await res.json();
    setSites(data.sites || []);
    setPeople(data.people || []);
  }
  useEffect(() => { load(); }, []);

  function openAdd() { setMsg(null); setForm(emptyForm()); }
  function openEdit(p: Person) {
    setMsg(null);
    setForm({
      id: p.id, name: p.name, role: p.role || '', costType: p.costType, amount: penniesToInput(p.amountPennies),
      rows: p.allocations.map((a, i) => ({ key: `${a.siteId}-${i}`, siteId: a.siteId, percent: String(a.percent) })),
      isChargeable: p.isChargeable, contractedHours: p.contractedHoursPerDay != null ? String(p.contractedHoursPerDay) : '', workingDays: [...p.workingDays],
    });
  }
  function close() { setForm(null); }

  const hoursOk = !form || form.contractedHours === '' || (Number.isFinite(Number(form.contractedHours)) && Number(form.contractedHours) >= 0 && Number(form.contractedHours) <= 24);
  const canSave = !!form && form.name.trim() !== '' && Number(form.amount) >= 0 && form.amount !== '' && allocIsValid(form.rows) && hoursOk;

  async function save() {
    if (!form || !canSave) return;
    setBusy(true); setMsg(null);
    const body = {
      id: form.id || undefined,
      name: form.name.trim(), role: form.role.trim() || null,
      costType: form.costType, amountPennies: poundsToPennies(form.amount),
      allocations: form.rows.map((r) => ({ siteId: r.siteId, percent: Number(r.percent) })),
      isChargeable: form.isChargeable,
      contractedHoursPerDay: form.contractedHours === '' ? null : Number(form.contractedHours),
      workingDays: form.workingDays,
    };
    try {
      const res = await fetch('/api/headcount', {
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
      const res = await fetch(`/api/headcount?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) { await load(); setForm(null); }
    } finally { setBusy(false); }
  }

  const payLabel = (p: Person) =>
    `${formatMoney(p.amountPennies)} ${p.costType === 'salary' ? t('perYear') : t('perHour')}`;

  return (
    <SettingsLayout isAdmin>
      <Head><title>Headcount - GreaseDesk</title></Head>
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
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-sm font-medium text-ink">{t('role')}</span>
                <input value={form.role} placeholder={t('rolePlaceholder')} onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-ink">{t('costType')}</span>
                <select value={form.costType} onChange={(e) => setForm({ ...form, costType: e.target.value as 'salary' | 'hourly' })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink">
                  <option value="salary">{t('salary')}</option>
                  <option value="hourly">{t('hourly')}</option>
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-ink">{t('amount')} ({form.costType === 'salary' ? t('perYear') : t('perHour')})</span>
                <input type="number" inputMode="decimal" min={0} step="0.01" value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
              </label>
            </div>

            <AllocationEditor sites={sites} rows={form.rows} onChange={(rows) => setForm({ ...form, rows })} t={t} />

            {/* ---- Employment shape (utilisation denominator inputs — lib/capacity reads all three) ---- */}
            <div className="mt-5 pt-4 border-t border-line space-y-3">
              <div className="text-sm font-medium text-ink">{t('shape.heading')}</div>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input type="checkbox" checked={form.isChargeable} onChange={(e) => setForm({ ...form, isChargeable: e.target.checked })} className="mt-0.5" />
                <span>{t('shape.chargeable')}<span className="block text-xs text-muted">{t('shape.chargeableHint')}</span></span>
              </label>
              <label className="block max-w-xs">
                <span className="text-sm font-medium text-ink">{t('shape.hours')}</span>
                <input type="number" inputMode="decimal" min={0} max={24} step="0.25" value={form.contractedHours}
                  onChange={(e) => setForm({ ...form, contractedHours: e.target.value })}
                  className="mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink" />
                {!hoursOk && <span className="block text-xs text-danger mt-1">{t('shape.hoursRange')}</span>}
                {form.isChargeable && form.contractedHours === '' && (
                  <span className="block text-xs text-warn mt-1">{t('shape.hoursNeeded')}</span>
                )}
              </label>
              <div>
                <span className="text-sm font-medium text-ink">{t('shape.workingDays')}</span>
                <div className="flex gap-1 mt-1">
                  {WEEKDAY_ORDER.map((d) => {
                    const explicit = form.workingDays.includes(d);
                    // Preview the INHERITED set (home = highest-% allocation) via THE capacity rule.
                    const home = [...form.rows].sort((a, b) => Number(b.percent) - Number(a.percent))[0]?.siteId;
                    const openDays = sites.find((s2) => s2.id === home)?.openDays;
                    const inherited = form.workingDays.length === 0 && rosteredWeekdays([], openDays).includes(d);
                    return (
                      <button key={d} type="button"
                        onClick={() => setForm({ ...form, workingDays: explicit ? form.workingDays.filter((x) => x !== d) : [...form.workingDays, d].sort() })}
                        className={`w-9 py-1.5 rounded-lg border text-xs font-medium ${explicit ? 'bg-accent text-white border-accent' : inherited ? 'bg-accent-soft text-accent border-accent border-dashed' : 'bg-surface text-muted border-line'}`}>
                        {t(`shape.dow.${d}`)}
                      </button>
                    );
                  })}
                </div>
                {form.workingDays.length === 0 ? (
                  <span className="block text-xs text-muted mt-1">
                    {t('shape.inherits', {
                      days: (() => {
                        const home = [...form.rows].sort((a, b) => Number(b.percent) - Number(a.percent))[0]?.siteId;
                        const open = rosteredWeekdays([], sites.find((s2) => s2.id === home)?.openDays);
                        return WEEKDAY_ORDER.filter((d) => open.includes(d)).map((d) => t(`shape.dow.${d}`)).join(' ') || t('shape.noSite');
                      })(),
                    })}
                  </span>
                ) : (
                  <button type="button" onClick={() => setForm({ ...form, workingDays: [] })} className="block text-xs text-accent underline mt-1">{t('shape.clearOverride')}</button>
                )}
              </div>
            </div>

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
            const here = people.filter((p) => p.allocations.some((a) => a.siteId === site.id));
            return (
              <div key={site.id}>
                <h3 className="text-sm font-semibold text-ink uppercase tracking-wide mb-2">{site.name}</h3>
                {here.length === 0 ? (
                  <p className="text-sm text-muted">{t('emptySite')}</p>
                ) : (
                  <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
                    {here.map((p) => {
                      const share = p.allocations.find((a) => a.siteId === site.id)!;
                      const shared = p.allocations.length > 1;
                      return (
                        <li key={p.id} className="flex items-center gap-3 p-3 bg-surface">
                          <div className="min-w-0 flex-1">
                            <div className="text-ink font-medium truncate">
                              {p.name}
                              {p.role ? <span className="text-muted font-normal"> · {p.role}</span> : null}
                            </div>
                            <div className="text-xs text-muted">{payLabel(p)}</div>
                            {p.isChargeable && (
                              <div className="text-[11px] text-muted">
                                {t('shape.summary', {
                                  hours: p.contractedHoursPerDay != null ? `${p.contractedHoursPerDay}h` : t('shape.noHours'),
                                  days: p.workingDays.length
                                    ? WEEKDAY_ORDER.filter((d) => p.workingDays.includes(d)).map((d) => t(`shape.dow.${d}`)).join(' ')
                                    : t('shape.inheritedShort'),
                                })}
                                {p.contractedHoursPerDay == null && <span className="text-warn"> · {t('shape.hoursNeeded')}</span>}
                              </div>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-ink font-semibold text-sm">{share.percent}%</div>
                            {shared && <span className="text-[10px] uppercase tracking-wide text-accent">{t('shared')}</span>}
                          </div>
                          <button onClick={() => openEdit(p)} className="shrink-0 text-sm text-accent hover:underline">{t('edit')}</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
          {people.length === 0 && sites.length > 0 && <p className="text-sm text-muted">{t('empty')}</p>}
        </div>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['headcount'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
});
