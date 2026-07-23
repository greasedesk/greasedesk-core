/**
 * File: pages/admin/hr.tsx
 * HR (ADMIN-only, server-enforced via requireAdminPage; every API here re-checks with
 * requireAdminApi — wages live on this page). Absorbs Settings→Headcount (now a redirect).
 * RECORD-FIRST: the Current tab edits the flat CostPerson columns (capacity/P&L/roster keep
 * reading those); every tracked change ALSO appends an EmploymentEvent in the same transaction
 * (lib/employment-events) — the History/Changes tabs render that append-only log, which IS the
 * audit surface (who / what / when / effective-date / old→new).
 * Tabs: Current employees · Former employees (mark-as-left keeps full history — never deleted) ·
 * Changes (group-level event list).
 */
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import Link from 'next/link';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';
import { displayCurrency } from '@/lib/display-currency';
import AllocationEditor, { AllocRow, allocIsValid } from '@/components/settings/AllocationEditor';
import { rosteredWeekdays } from '@/lib/rostered-days';

type SiteOpt = { id: string; name: string; isActive: boolean; openDays?: number[] };
type Alloc = { siteId: string; percent: number };
type Person = {
  id: string; name: string; role: string | null; costType: 'salary' | 'hourly'; amountPennies: number; isActive: boolean;
  isChargeable: boolean; contractedHoursPerDay: number | null; workingDays: number[];
  startDate: string | null; endDate: string | null; allowanceDays: number | null;
  utilisationFactor: number;
  allocations: Alloc[];
};
type Ev = { id: string; personId: string; personName: string; kind: string; effectiveDate: string; value: any; previous: any; changedBy: string | null; at: string; corrections?: Array<{ at: string; by: string | null; from: string; to: string }>; voided?: boolean };

type FormState = {
  id: string | null; name: string; role: string; costType: 'salary' | 'hourly'; amount: string; rows: AllocRow[];
  isChargeable: boolean; contractedHours: string; workingDays: number[]; startDate: string;
  utilisationFactor: string;
  effectiveDate: string; confirmDated: boolean;
};

const emptyForm = (): FormState => ({
  id: null, name: '', role: '', costType: 'salary', amount: '', rows: [],
  isChargeable: false, contractedHours: '', workingDays: [], startDate: '',
  utilisationFactor: '70',
  effectiveDate: new Date().toISOString().slice(0, 10), confirmDated: false,
});
const poundsToPennies = (s: string): number => Math.round((Number(s) || 0) * 100);
const penniesToInput = (p: number): string => (p / 100).toFixed(2);
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const inputClass = 'mt-1 w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink';

export default function HrPage({ currency, locale }: { currency: string; locale: string }) {
  const { t } = useTranslation('headcount');
  const { t: th } = useTranslation('hr');
  const router = useRouter();
  const [tab, setTab] = useState<'current' | 'former' | 'changes'>('current');
  const [sites, setSites] = useState<SiteOpt[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [changes, setChanges] = useState<Ev[] | null>(null);
  const [history, setHistory] = useState<Record<string, Ev[]>>({});
  const [form, setForm] = useState<FormState | null>(null);
  const [leaving, setLeaving] = useState<{ id: string; endDate: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    const res = await fetch('/api/headcount');
    if (!res.ok) return null;
    const data = await res.json();
    setSites(data.sites || []);
    setPeople(data.people || []);
    return (data.people || []) as Person[];
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (tab === 'changes' && changes === null) {
      fetch('/api/employment-events').then((r) => (r.ok ? r.json() : null)).then((d) => d && setChanges(d.events));
    }
  }, [tab, changes]);
  // Guided-setup walkthrough: auto-open the add-employee form on arrival (item-13).
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (!autoOpened && router.query.add === '1') { setAutoOpened(true); setMsg(null); setForm(emptyForm()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.query.add]);

  async function loadHistory(personId: string, force = false) {
    if (!force && history[personId]) return; // force: the caller just invalidated the cache (stale closure would still see it)
    const r = await fetch(`/api/employment-events?personId=${personId}`);
    if (!r.ok) return;
    const evs = (await r.json()).events ?? [];
    setHistory((h) => ({ ...h, [personId]: evs }));
  }

  function openEdit(p: Person) {
    setMsg(null);
    setForm({
      id: p.id, name: p.name, role: p.role || '', costType: p.costType, amount: penniesToInput(p.amountPennies),
      rows: p.allocations.map((a, i) => ({ key: `${a.siteId}-${i}`, siteId: a.siteId, percent: String(a.percent) })),
      isChargeable: p.isChargeable, contractedHours: p.contractedHoursPerDay != null ? String(p.contractedHoursPerDay) : '',
      workingDays: [...p.workingDays], startDate: p.startDate ?? '',
      utilisationFactor: String(p.utilisationFactor ?? 70),
      // DELIBERATE pick: edits append dated history, so the effective date starts EMPTY and the
      // save stays disabled until it's chosen — never a silent "today".
      effectiveDate: '', confirmDated: false,
    });
  }

  const hoursOk = !form || form.contractedHours === '' || (Number.isFinite(Number(form.contractedHours)) && Number(form.contractedHours) >= 0 && Number(form.contractedHours) <= 24);
  const canSave = !!form && form.name.trim() !== '' && Number(form.amount) >= 0 && form.amount !== '' && allocIsValid(form.rows) && hoursOk
    && (!form.id || form.effectiveDate !== ''); // edits REQUIRE a chosen effective date

  async function save(confirmDated = false) {
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
      utilisationFactor: form.utilisationFactor === '' ? 70 : Number(form.utilisationFactor),
      startDate: form.startDate || null,
      effectiveDate: form.effectiveDate,
      confirmDated: confirmDated || form.confirmDated,
    };
    try {
      const res = await fetch('/api/headcount', {
        method: form.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.needsDateConfirm) {
        // Far-past/future effective date: explicit confirm, never silent.
        if (window.confirm(`${data.message}\n\n${th('confirmDated')}`)) { setForm({ ...form, confirmDated: true }); await saveWith(body); }
        return;
      }
      if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); return; }
      // Guided-setup walkthrough: a NEW employee returns to the sequence so it advances (item-13).
      if (!form.id && router.query.setup === '1') { router.push('/admin/setup?walk=1'); return; }
      await afterSaved(form.id);
    } catch { setMsg({ text: t('error'), ok: false }); }
    finally { setBusy(false); } // ALWAYS back to idle — the refresh doesn't remount this page
  }
  async function saveWith(body: any) {
    const res = await fetch('/api/headcount', { method: body.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, confirmDated: true }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); return; }
    await afterSaved(body.id ?? null);
  }
  // Post-save: await the refresh, then re-open the form on the SAVED values — Save sits disabled
  // (no effective date yet) until something is edited again. A new person just joins the list.
  async function afterSaved(id: string | null) {
    const fresh = await load();
    setHistory({}); setChanges(null);
    const updated = id ? fresh?.find((p) => p.id === id) : null;
    if (updated) openEdit(updated); else setForm(null);
    setMsg({ text: t('saved'), ok: true }); // after openEdit — it clears msg
  }

  async function markLeft() {
    if (!leaving) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/headcount', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: leaving.id, action: 'markLeft', endDate: leaving.endDate }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg({ text: data?.message || t('error'), ok: false });
      else { setLeaving(null); setForm(null); setHistory({}); setChanges(null); await load(); setMsg({ text: th('leftDone'), ok: true }); }
    } catch { setMsg({ text: t('error'), ok: false }); }
    finally { setBusy(false); }
  }

  const payLabel = (p: Person) => `${formatMoney(p.amountPennies, { currency, locale })} ${p.costType === 'salary' ? t('perYear') : t('perHour')}`;
  const dayNames = (ds: number[]) => WEEKDAY_ORDER.filter((d) => ds.includes(d)).map((d) => t(`shape.dow.${d}`)).join(' ');
  // One readable line per event kind (old → new).
  const evText = (e: Ev): string => {
    const v = e.value || {}; const p = e.previous || {};
    switch (e.kind) {
      case 'wage': return `${p.amount_pennies != null ? formatMoney(p.amount_pennies, { currency, locale }) : '—'} → ${formatMoney(v.amount_pennies, { currency, locale })} (${v.cost_type === 'salary' ? t('perYear') : t('perHour')})`;
      case 'hours': return `${p.contracted_hours_per_day ?? '—'}h → ${v.contracted_hours_per_day ?? '—'}h`;
      case 'pattern': return `${p.working_days?.length ? dayNames(p.working_days) : th('inherited')} → ${v.working_days?.length ? dayNames(v.working_days) : th('inherited')}`;
      case 'chargeable': return `${p.is_chargeable ? th('yes') : th('no')} → ${v.is_chargeable ? th('yes') : th('no')}`;
      case 'allowance': return `${p.annual_leave_allowance_days ?? '—'} → ${v.annual_leave_allowance_days ?? '—'} ${th('days')}`;
      case 'factor': return `${p?.utilisation_factor ?? '—'}% → ${v.utilisation_factor ?? '—'}%`;
      case 'name': return `${p?.name ?? '—'} → ${v.name ?? '—'}`;
      case 'role': return `${p?.role ?? '—'} → ${v.role ?? '—'}`;
      case 'started': return `${p?.start_date ?? '—'} → ${v.start_date ?? '—'}`;
      case 'ended': return `${v.end_date ?? '—'}`;
      default: return JSON.stringify(v);
    }
  };
  async function correctEvent(personId: string, id: string, action: 'redate' | 'void', effectiveDate?: string) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/employment-events', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, effectiveDate }) });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d?.needsDateConfirm) {
        if (window.confirm(`${d.message}\n\n${th('confirmDated')}`)) {
          const res2 = await fetch('/api/employment-events', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, effectiveDate, confirmDated: true }) });
          const d2 = await res2.json().catch(() => ({}));
          setMsg({ text: d2?.message || t('error'), ok: res2.ok });
        }
      } else setMsg({ text: d?.message || t('error'), ok: res.ok });
      setHistory({}); setChanges(null);
      await loadHistory(personId, true); // the open pane can't re-trigger onToggle — refresh it here, never leave it on "Loading…"
    } catch { setMsg({ text: t('error'), ok: false }); }
    finally { setBusy(false); }
  }
  const [fixing, setFixing] = useState<{ id: string; date: string } | null>(null);
  const EvRow = ({ e, withName }: { e: Ev; withName?: boolean }) => (
    <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 border-b border-line/40 last:border-0 text-sm ${e.voided ? 'opacity-50' : ''}`}>
      <span className="text-muted tabular-nums w-24 shrink-0">{new Date(`${e.effectiveDate}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' })}</span>
      {withName && <span className="font-medium text-ink">{e.personName}</span>}
      <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-surface-muted border border-line text-ink">{th(`kind.${e.kind}`)}</span>
      <span className={`text-ink ${e.voided ? 'line-through' : ''}`}>{evText(e)}</span>
      {e.voided && <span className="text-xs font-medium text-danger">{th('voided')}</span>}
      {!e.voided && (e.corrections?.length ?? 0) > 0 && (
        <span className="text-xs text-warn" title={e.corrections!.map((c) => `${c.from} → ${c.to} (${c.by ?? '—'}, ${new Date(c.at).toLocaleString('en-GB')})`).join('\n')}>
          {th('corrected', { from: e.corrections![e.corrections!.length - 1].from })}
        </span>
      )}
      <span className="ml-auto text-xs text-muted">{e.changedBy ?? '—'} · {new Date(e.at).toLocaleString('en-GB')}</span>
      {!e.voided && (fixing?.id === e.id ? (
        <span className="flex items-center gap-1.5">
          <input type="date" value={fixing.date} onChange={(ev2) => setFixing({ id: e.id, date: ev2.target.value })} className="p-1 bg-surface border border-line rounded text-ink text-xs" />
          <button onClick={() => { correctEvent(e.personId, e.id, 'redate', fixing.date); setFixing(null); }} disabled={busy || !fixing.date} className="text-xs text-accent underline disabled:opacity-40">{t('save')}</button>
          <button onClick={() => setFixing(null)} className="text-xs text-muted">{t('cancel')}</button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <button onClick={() => setFixing({ id: e.id, date: e.effectiveDate })} className="text-xs text-accent underline">{th('fixDate')}</button>
          <button onClick={() => { if (window.confirm(th('voidConfirm'))) correctEvent(e.personId, e.id, 'void'); }} disabled={busy} className="text-xs text-danger underline disabled:opacity-40">{th('void')}</button>
        </span>
      ))}
    </div>
  );

  const current = people.filter((p) => p.isActive);
  const former = people.filter((p) => !p.isActive);

  return (
    <>
      <Head><title>{th('title')} - GreaseDesk</title></Head>
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <h1 className="text-xl font-bold text-ink">{th('title')}</h1>
          {tab === 'current' && !form && (
            <button onClick={() => { setMsg(null); setForm(emptyForm()); }} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm">{t('add')}</button>
          )}
        </div>
        <p className="text-sm text-muted mb-4">{th('intro')}</p>
        <div className="flex gap-1.5 mb-4">
          {(['current', 'former', 'changes'] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)} className={`text-sm rounded-lg px-3 py-2 border ${tab === k ? 'bg-accent text-white border-accent font-semibold' : 'bg-surface text-ink border-line hover:bg-surface-muted'}`}>{th(`tab.${k}`)}</button>
          ))}
        </div>
        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        {form && tab === 'current' && (
          <div className="bg-surface border border-line rounded-xl p-4 sm:p-6 mb-5">
            <h3 className="font-semibold text-ink mb-3">{form.id ? t('edit') : t('add')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2"><span className="text-sm font-medium text-ink">{t('name')}</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} /></label>
              <label className="block sm:col-span-2"><span className="text-sm font-medium text-ink">{t('role')}</span>
                <input value={form.role} placeholder={t('rolePlaceholder')} onChange={(e) => setForm({ ...form, role: e.target.value })} className={inputClass} /></label>
              <label className="block"><span className="text-sm font-medium text-ink">{t('costType')}</span>
                <select value={form.costType} onChange={(e) => setForm({ ...form, costType: e.target.value as 'salary' | 'hourly' })} className={inputClass}>
                  <option value="salary">{t('salary')}</option>
                  <option value="hourly">{t('hourly')}</option>
                </select></label>
              <label className="block"><span className="text-sm font-medium text-ink">{t('amount')} ({form.costType === 'salary' ? t('perYear') : t('perHour')})</span>
                <input type="number" inputMode="decimal" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputClass} /></label>
              <label className="block"><span className="text-sm font-medium text-ink">{th('startDate')}</span>
                <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputClass} /></label>
            </div>

            <AllocationEditor sites={sites} rows={form.rows} onChange={(rows) => setForm({ ...form, rows })} t={t} />

            <div className="mt-5 pt-4 border-t border-line space-y-3">
              <div className="text-sm font-medium text-ink">{t('shape.heading')}</div>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input type="checkbox" checked={form.isChargeable} onChange={(e) => setForm({ ...form, isChargeable: e.target.checked })} className="mt-0.5" />
                <span>{t('shape.chargeable')}<span className="block text-xs text-muted">{t('shape.chargeableHint')}</span></span>
              </label>
              {form.isChargeable && (
                <label className="block max-w-xs"><span className="text-sm font-medium text-ink">{th('factor.label')}</span>
                  <div className="flex items-center gap-1.5">
                    <input type="number" inputMode="numeric" min={0} max={100} step={1} value={form.utilisationFactor}
                      onChange={(e) => setForm({ ...form, utilisationFactor: e.target.value })} className={inputClass + ' w-24'} />
                    <span className="text-sm text-muted mt-1">%</span>
                  </div>
                  <span className="block text-xs text-muted mt-1">{th('factor.hint')}</span>
                </label>
              )}
              <label className="block max-w-xs"><span className="text-sm font-medium text-ink">{t('shape.hours')}</span>
                <input type="number" inputMode="decimal" min={0} max={24} step="0.25" value={form.contractedHours} onChange={(e) => setForm({ ...form, contractedHours: e.target.value })} className={inputClass} />
                {!hoursOk && <span className="block text-xs text-danger mt-1">{t('shape.hoursRange')}</span>}
                {form.isChargeable && form.contractedHours === '' && <span className="block text-xs text-warn mt-1">{t('shape.hoursNeeded')}</span>}
              </label>
              <div>
                <span className="text-sm font-medium text-ink">{t('shape.workingDays')}</span>
                <div className="flex gap-1 mt-1">
                  {WEEKDAY_ORDER.map((d) => {
                    const explicit = form.workingDays.includes(d);
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

            {/* Commit block: the effective date lives WITH Save (one action) — flow reads
                edit the fields → state when the change took effect → Save. */}
            {form.id && (
              <div className="mt-5 rounded-lg border-2 border-accent bg-accent-soft/40 p-3">
                <label className="block max-w-xs">
                  <span className="text-sm font-semibold text-accent">{th('effectiveDate')} *</span>
                  <input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value, confirmDated: false })} className={inputClass} />
                </label>
                <span className="block text-xs text-muted mt-1">{form.effectiveDate === '' ? th('effectiveRequired') : th('effectiveHint')}</span>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={() => save()} disabled={busy || !canSave} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">{busy ? t('saving') : t('save')}</button>
              {/* The disabled reason, stated inline — never a silently-greyed button. */}
              {!busy && !canSave && form.id && form.effectiveDate === '' && (
                <span className="text-xs text-warn">{th('saveNeedsDate')}</span>
              )}
              <button onClick={() => setForm(null)} className="text-muted hover:text-ink rounded-lg px-4 py-2 text-sm">{t('cancel')}</button>
              {form.id && (leaving?.id === form.id ? (
                <span className="ml-auto flex items-center gap-2 text-sm">
                  <input type="date" value={leaving.endDate} onChange={(e) => setLeaving({ id: form.id!, endDate: e.target.value })} className="p-1.5 bg-surface border border-line rounded-lg text-ink text-sm" />
                  <button onClick={markLeft} disabled={busy || !leaving.endDate} className="text-danger font-medium disabled:opacity-50">{th('confirmLeft')}</button>
                  <button onClick={() => setLeaving(null)} className="text-muted">{t('cancel')}</button>
                </span>
              ) : (
                <button onClick={() => setLeaving({ id: form.id!, endDate: new Date().toISOString().slice(0, 10) })} disabled={busy}
                  className="ml-auto text-danger hover:bg-danger-soft rounded-lg px-3 py-2 text-sm">{th('markLeft')}</button>
              ))}
            </div>
          </div>
        )}

        {(tab === 'current' || tab === 'former') && (
          <div className="space-y-2">
            {(tab === 'current' ? current : former).length === 0 && (
              <p className="text-sm text-muted">{tab === 'current' ? t('empty') : th('noFormer')}</p>
            )}
            {(tab === 'current' ? current : former).map((p) => (
              <details key={p.id} className="bg-surface border border-line rounded-xl" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadHistory(p.id); }}>
                <summary className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 cursor-pointer list-none">
                  <span className="font-semibold text-ink">{p.name}</span>
                  {p.role && <span className="text-xs text-muted">{p.role}</span>}
                  <span className="text-xs text-muted">{payLabel(p)}</span>
                  {p.isChargeable && <span className="text-[11px] text-muted">· {t('shape.summary', { hours: p.contractedHoursPerDay != null ? `${p.contractedHoursPerDay}h` : t('shape.noHours'), days: p.workingDays.length ? dayNames(p.workingDays) : t('shape.inheritedShort') })}</span>}
                  <span className="ml-auto text-xs text-muted tabular-nums">
                    {p.startDate ? `${th('started')} ${p.startDate}` : ''}{!p.isActive && p.endDate ? ` · ${th('ended')} ${p.endDate}` : ''}
                  </span>
                  {tab === 'current' && <button onClick={(e) => { e.preventDefault(); openEdit(p); }} className="text-sm text-accent hover:underline">{t('edit')}</button>}
                </summary>
                <div className="px-3 pb-3 border-t border-line/60">
                  <div className="text-xs font-semibold text-muted uppercase tracking-wide pt-2 pb-1">{th('historyHeading')}</div>
                  {!history[p.id] ? <p className="text-sm text-muted py-1">{th('loading')}</p>
                    : history[p.id].length === 0 ? <p className="text-sm text-muted py-1">{th('noHistory')}</p>
                    : history[p.id].map((e) => <EvRow key={e.id} e={e} />)}
                </div>
              </details>
            ))}
          </div>
        )}

        {tab === 'changes' && (
          <div className="bg-surface border border-line rounded-xl p-4">
            {!changes ? <p className="text-muted">{th('loading')}</p>
              : changes.length === 0 ? <p className="text-sm text-muted">{th('noHistory')}</p>
              : changes.map((e) => <EvRow key={e.id} e={e} withName />)}
          </div>
        )}

        <p className="text-xs text-muted mt-4">{th('recordFirstNote')} <Link href="/admin/roster" className="text-accent underline">{th('rosterLink')}</Link></p>
      </div>
    </>
  );
}

export const getServerSideProps = withI18n(['hr', 'headcount'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: { ...(await displayCurrency(gate.vis.primarySiteId)) } };
});
