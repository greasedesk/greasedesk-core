/**
 * File: pages/admin/roster.tsx
 * Roster — the home for ALL leave data + the bank-holiday list (absorbs the standalone manager
 * leave-entry UI and the banked PH-entry UI). Role views are SERVER-enforced (lib/roster via
 * /api/roster — this page renders whatever the server scoped): ADMIN = all sites/people +
 * allowance editing; SITE_MANAGER = their sites' people + own record; STANDARD = own record,
 * read-only. v1: every entry is manager/admin-made and approved — the "Status" column is the
 * designed-for home of the banked mechanic request→approve flow.
 * Two populations (deliberate): everyone appears here (all staff get holidays); only
 * is_chargeable people feed the utilisation denominator.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';

type LeaveRow = { id: string; date: string; hours: number | null; type: string; status: string; siteId: string };
type Person = {
  id: string; name: string; role: string | null; isChargeable: boolean; contractedHoursPerDay: number | null;
  allowanceDays: number | null; takenDays: number; balanceDays: number | null;
  homeSiteId: string | null; alsoAtSiteIds: string[]; isSelf: boolean; editable: boolean; leave: LeaveRow[];
};
type Roster = { people: Person[]; sites: Array<{ id: string; name: string }>; canWrite: boolean; canEditAllowance: boolean; year: number };
type Holiday = { id: string; date: string; label: string; siteId: string | null };

const inputCls = 'p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const btnCls = 'text-sm rounded-lg px-3 py-2 bg-surface-muted border border-line text-ink disabled:opacity-50';

// Leave-type chip — `closure` is a company-mandated shutdown: visually distinct from
// discretionary annual leave so a mechanic sees WHY those days are pre-booked.
function TypeChip({ type, t }: { type: string; t: (k: string) => string }) {
  const tone = type === 'closure' ? 'bg-accent-soft text-accent' : type === 'sick' ? 'bg-warn-soft text-warn' : 'bg-surface-muted text-ink border border-line';
  return <span className={`text-xs font-medium rounded-full px-2 py-0.5 whitespace-nowrap ${tone}`}>{t(`type.${type}`)}</span>;
}

// Add/edit leave form — module-level component (remount rule: stable element type).
function LeaveForm({ personId, initial, t, onDone, onCancel }: {
  personId: string; initial?: LeaveRow | null; t: (k: string, o?: any) => string; onDone: () => void; onCancel: () => void;
}) {
  const [date, setDate] = useState(initial?.date ?? '');
  const [type, setType] = useState(initial?.type ?? 'annual');
  const [hours, setHours] = useState(initial?.hours != null ? String(initial.hours) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    const body = initial
      ? { id: initial.id, date, type, hours: hours.trim() === '' ? null : Number(hours) }
      : { costPersonId: personId, date, type, hours: hours.trim() === '' ? undefined : Number(hours) };
    try {
      const res = await fetch('/api/roster-leave', { method: initial ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || t('leave.error')); setBusy(false); return; }
      onDone();
    } catch { setErr(t('leave.error')); setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-end gap-2 py-2">
      <label className="block"><span className="block text-xs text-muted mb-1">{t('leave.date')}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></label>
      <label className="block"><span className="block text-xs text-muted mb-1">{t('leave.type')}</span>
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
          {['annual', 'sick', 'other', 'closure'].map((k) => <option key={k} value={k}>{t(`type.${k}`)}</option>)}
        </select></label>
      <label className="block"><span className="block text-xs text-muted mb-1">{t('leave.hours')}</span>
        <input type="number" step="0.25" min="0" value={hours} onChange={(e) => setHours(e.target.value)} placeholder={t('leave.fullDay')} className={`${inputCls} w-28`} /></label>
      <button onClick={save} disabled={busy || !date} className={btnCls}>{busy ? t('leave.saving') : t('leave.save')}</button>
      <button onClick={onCancel} className="text-sm text-muted hover:text-ink px-2 py-2">{t('leave.cancel')}</button>
      {err && <span className="text-sm text-danger w-full">{err}</span>}
    </div>
  );
}

// Admin-only inline allowance editor (per-person figure — never apportioned across sites).
function AllowanceEditor({ personId, initial, t, onSaved }: { personId: string; initial: number | null; t: (k: string, o?: any) => string; onSaved: () => void }) {
  const [val, setVal] = useState(initial != null ? String(initial) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/roster', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ costPersonId: personId, allowanceDays: Number(val) }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || t('allowance.error')); setBusy(false); return; }
      onSaved();
    } catch { setErr(t('allowance.error')); setBusy(false); }
    setBusy(false);
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input type="number" step="0.5" min="0" value={val} onChange={(e) => setVal(e.target.value)} className={`${inputCls} w-20 py-1`} />
      <button onClick={save} disabled={busy || val === '' || Number(val) === initial} className="text-xs text-accent underline disabled:opacity-40">{busy ? t('leave.saving') : t('allowance.save')}</button>
      {err && <span className="text-xs text-danger">{err}</span>}
    </span>
  );
}

export default function RosterPage() {
  const { t } = useTranslation('roster');
  const [tab, setTab] = useState<'leave' | 'holidays'>('leave');
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [roster, setRoster] = useState<Roster | null>(null);
  const [holidays, setHolidays] = useState<Holiday[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);  // personId with open add-form
  const [editing, setEditing] = useState<string | null>(null); // leave row id being edited
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, h] = await Promise.all([
        fetch(`/api/roster?year=${year}`, { cache: 'no-store' }),
        fetch('/api/public-holidays', { cache: 'no-store' }),
      ]);
      if (r.ok) setRoster(await r.json());
      if (h.ok) setHolidays((await h.json()).holidays);
    } catch { /* keep last */ }
  }, [year]);
  useEffect(() => { load(); }, [load]);
  const refresh = () => { setAdding(null); setEditing(null); load(); };

  async function removeLeave(id: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/roster-leave', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!res.ok) setMsg(((await res.json().catch(() => ({}))) as any)?.message || t('leave.error'));
      refresh();
    } catch { setMsg(t('leave.error')); }
    setBusy(false);
  }
  async function holidayAction(method: string, body: any) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/public-holidays', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      setMsg(d?.message || null);
      if (res.ok) load();
    } catch { setMsg(t('holidays.error')); }
    setBusy(false);
  }

  const siteName = (id: string | null) => roster?.sites.find((s) => s.id === id)?.name ?? t('unassigned');
  // ADMIN/manager grouping: person appears ONCE under their home site (highest allocation %,
  // ties → earliest-created site) with an "also at" note — never a duplicated row.
  const groups = (() => {
    if (!roster) return [];
    const bySite = new Map<string | null, Person[]>();
    for (const p of roster.people) {
      const k = p.homeSiteId;
      bySite.set(k, [...(bySite.get(k) ?? []), p]);
    }
    const ordered: Array<{ key: string | null; name: string; people: Person[] }> = [];
    for (const s of roster.sites) if (bySite.has(s.id)) ordered.push({ key: s.id, name: s.name, people: bySite.get(s.id)! });
    if (bySite.has(null)) ordered.push({ key: null, name: t('unassigned'), people: bySite.get(null)! });
    return ordered;
  })();

  const singlePerson = roster && !roster.canWrite; // STANDARD: own record only, read-only

  return (
    <>
      <Head><title>{t('title')} - GreaseDesk</title></Head>
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h1 className="text-xl font-bold text-ink">{t('title')}</h1>
          <div className="flex items-center gap-1.5">
            {[year - 1, year, year + 1].filter((y) => Math.abs(y - new Date().getUTCFullYear()) <= 1).map((y) => (
              <button key={y} onClick={() => setYear(y)} className={`text-sm rounded-lg px-3 py-1.5 border ${y === year ? 'bg-accent text-white border-accent font-semibold' : 'bg-surface text-ink border-line'}`}>{y}</button>
            ))}
          </div>
        </div>
        <div className="flex gap-1.5 mb-4">
          {(['leave', 'holidays'] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)} className={`text-sm rounded-lg px-3 py-2 border ${tab === k ? 'bg-accent text-white border-accent font-semibold' : 'bg-surface text-ink border-line hover:bg-surface-muted'}`}>{t(`tab.${k}`)}</button>
          ))}
        </div>
        {msg && <div className="p-2 rounded-lg mb-3 text-sm bg-surface-muted border border-line text-ink">{msg}</div>}

        {tab === 'leave' && !roster && <p className="text-muted">{t('loading')}</p>}
        {tab === 'leave' && roster && roster.people.length === 0 && (
          <div className="bg-surface border border-line rounded-xl p-8 text-center text-muted">{singlePerson ? t('noRecord') : t('noPeople')}</div>
        )}
        {tab === 'leave' && roster && groups.map((g) => (
          <div key={g.key ?? 'none'} className="mb-5">
            {!singlePerson && <h2 className="text-sm font-semibold text-muted mb-2">{g.name}</h2>}
            <div className="space-y-2">
              {g.people.map((p) => (
                <details key={p.id} className="bg-surface border border-line rounded-xl">
                  <summary className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 cursor-pointer list-none">
                    <span className="font-semibold text-ink">{p.name}</span>
                    {p.role && <span className="text-xs text-muted">{p.role}</span>}
                    {p.alsoAtSiteIds.length > 0 && <span className="text-xs text-muted italic">{t('alsoAt', { sites: p.alsoAtSiteIds.map(siteName).join(', ') })}</span>}
                    <span className="ml-auto text-sm tabular-nums text-ink">
                      {t('summaryLine', { allowance: p.allowanceDays ?? '—', taken: p.takenDays, balance: p.balanceDays ?? '—' })}
                    </span>
                  </summary>
                  <div className="px-3 pb-3 border-t border-line/60">
                    {roster.canEditAllowance && (
                      <div className="py-2 text-sm text-muted flex items-center gap-2">{t('allowance.label')}: <AllowanceEditor personId={p.id} initial={p.allowanceDays} t={t} onSaved={refresh} /></div>
                    )}
                    {p.leave.length === 0 && <p className="text-sm text-muted py-2">{t('leave.none', { year })}</p>}
                    {p.leave.map((l) => editing === l.id ? (
                      <LeaveForm key={l.id} personId={p.id} initial={l} t={t} onDone={refresh} onCancel={() => setEditing(null)} />
                    ) : (
                      <div key={l.id} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-line/40 last:border-0">
                        <span className="text-sm text-ink tabular-nums w-28">{new Date(`${l.date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' })}</span>
                        <TypeChip type={l.type} t={t} />
                        <span className="text-sm text-muted">{l.hours == null ? t('leave.fullDay') : t('leave.hoursN', { n: l.hours })}</span>
                        <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-ok-soft text-ok ml-auto">{t(`status.${l.status}`)}</span>
                        {p.editable && (
                          <>
                            <button onClick={() => setEditing(l.id)} className="text-xs text-accent underline">{t('leave.edit')}</button>
                            <button onClick={() => removeLeave(l.id)} disabled={busy} className="text-xs text-danger underline disabled:opacity-40">{t('leave.delete')}</button>
                          </>
                        )}
                      </div>
                    ))}
                    {p.editable && (adding === p.id
                      ? <LeaveForm personId={p.id} t={t} onDone={refresh} onCancel={() => setAdding(null)} />
                      : <button onClick={() => setAdding(p.id)} className="mt-2 text-sm text-accent underline">{t('leave.add')}</button>)}
                  </div>
                </details>
              ))}
            </div>
          </div>
        ))}

        {tab === 'holidays' && (
          <div className="bg-surface border border-line rounded-xl p-4">
            {!holidays ? <p className="text-muted">{t('loading')}</p> : (
              <>
                {holidays.length === 0 && <p className="text-sm text-muted mb-3">{t('holidays.empty')}</p>}
                {holidays.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-line/40 last:border-0">
                    <span className="text-sm text-ink tabular-nums w-28">{new Date(`${h.date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' })}</span>
                    <span className="text-sm text-ink">{h.label}</span>
                    {h.siteId && <span className="text-xs text-muted">({siteName(h.siteId)})</span>}
                    {roster?.canEditAllowance && (
                      <button onClick={() => holidayAction('DELETE', { id: h.id })} disabled={busy} className="ml-auto text-xs text-danger underline disabled:opacity-40">{t('leave.delete')}</button>
                    )}
                  </div>
                ))}
                {roster?.canEditAllowance && <HolidayAdd t={t} busy={busy} onAdd={(b) => holidayAction('POST', b)} onSeed={() => holidayAction('POST', { action: 'seedEW' })} />}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// Admin holiday add + one-click England & Wales seed (idempotent server-side).
function HolidayAdd({ t, busy, onAdd, onSeed }: { t: (k: string, o?: any) => string; busy: boolean; onAdd: (b: any) => void; onSeed: () => void }) {
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-line">
      <label className="block"><span className="block text-xs text-muted mb-1">{t('leave.date')}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></label>
      <label className="block"><span className="block text-xs text-muted mb-1">{t('holidays.name')}</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} /></label>
      <button onClick={() => { onAdd({ date, label }); setDate(''); setLabel(''); }} disabled={busy || !date || !label.trim()} className={btnCls}>{t('holidays.add')}</button>
      <button onClick={onSeed} disabled={busy} className={btnCls}>{t('holidays.seed')}</button>
    </div>
  );
}

export const getServerSideProps = withI18n(['roster'])(async (ctx: any) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  return { props: {} };
});
