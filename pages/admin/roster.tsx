/**
 * File: pages/admin/roster.tsx
 * Roster — the home for ALL leave data + the bank-holiday list. Role views are SERVER-enforced
 * (lib/roster via /api/roster): ADMIN all sites/people + allowance edit; SITE_MANAGER their
 * sites' people + own record; STANDARD own record read-only. v1: entries are manager/admin-made,
 * approved — the Status column is the designed-for home of the banked request→approve flow.
 * Two populations (deliberate): everyone appears here; only is_chargeable feeds utilisation.
 *
 * Leave entry is RANGE-BASED (start→end): the server expands to per-day rows on WORKING days
 * only (the capacity rostered-day helpers — one truth), skipping bank holidays and existing
 * bookings, and REPORTS every skipped day with its reason (shown in the confirmation — the
 * deduction is always explainable). Rows of one booking share a batch id and display/edit/
 * delete as ONE line; legacy null-batch rows keep per-row actions.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { getServerSession } from 'next-auth';
import { useTranslation } from 'next-i18next';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { withI18n } from '@/lib/gssp-i18n';
import { LEAVE_TYPES, DEFAULT_LEAVE_COLOURS, LeaveTypeKey } from '@/lib/leave-types';

type LeaveRow = { id: string; date: string; hours: number | null; type: string; status: string; siteId: string; batchId: string | null };
type Person = {
  id: string; name: string; role: string | null; isChargeable: boolean; contractedHoursPerDay: number | null;
  allowanceDays: number | null; takenDays: number; balanceDays: number | null;
  homeSiteId: string | null; alsoAtSiteIds: string[]; isSelf: boolean; editable: boolean; leave: LeaveRow[];
};
type Roster = { people: Person[]; sites: Array<{ id: string; name: string }>; canWrite: boolean; canEditAllowance: boolean; year: number; colours?: Record<string, string> };
type Holiday = { id: string; date: string; label: string; siteId: string | null };
type SaveResult = { booked?: string[]; skipped?: Array<{ date: string; reason: string }> };

const inputCls = 'p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const btnCls = 'text-sm rounded-lg px-3 py-2 bg-surface-muted border border-line text-ink disabled:opacity-50';
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// A booking = the rows sharing a batch id (legacy null-batch rows stand alone).
type Booking = { batchId: string | null; rowId: string; dates: string[]; hours: number | null; type: string; status: string };
function groupBookings(rows: LeaveRow[]): Booking[] {
  const byBatch = new Map<string, LeaveRow[]>();
  const singles: Booking[] = [];
  for (const r of rows) {
    if (r.batchId) byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), r]);
    else singles.push({ batchId: null, rowId: r.id, dates: [r.date], hours: r.hours, type: r.type, status: r.status });
  }
  const batches: Booking[] = Array.from(byBatch.entries()).map(([batchId, rs]) => ({
    batchId, rowId: rs[0].id, dates: rs.map((r) => r.date).sort(), hours: rs[0].hours, type: rs[0].type, status: rs[0].status,
  }));
  return [...batches, ...singles].sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
}

// Leave-type chip — coloured from the tenant's (admin-remappable) map so every type is
// distinguishable at a glance; defaults are the Okabe–Ito colour-blind-safe palette.
function TypeChip({ type, colours, t }: { type: string; colours: Record<string, string>; t: (k: string) => string }) {
  const c = colours[type] ?? DEFAULT_LEAVE_COLOURS.other;
  return (
    <span className="text-xs font-medium rounded-full px-2 py-0.5 whitespace-nowrap border"
      style={{ color: c, borderColor: c, backgroundColor: `${c}1A` }}>
      {t(`type.${type}`)}
    </span>
  );
}

// Range entry form (module-level — stable element type). End defaults to Start; Half-day only
// when a single day; the arbitrary custom-hours field is KEPT as the advanced single-day option
// (retiring it is a small removal if ruled). Skips come back in the save result for the banner.
function LeaveForm({ personId, batch, t, onDone, onCancel }: {
  personId: string;
  batch?: { batchId: string; start: string; end: string; type: string } | null;
  t: (k: string, o?: any) => string;
  onDone: (r: SaveResult, msg: string) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState(batch?.start ?? '');
  const [end, setEnd] = useState(batch?.end ?? '');
  const [type, setType] = useState(batch?.type ?? 'annual');
  const [halfDay, setHalfDay] = useState(false);
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const effEnd = end || start;
  const single = !!start && start === effEnd;
  async function save() {
    if (start && effEnd < start) { setErr(t('leave.endBeforeStart')); return; }
    setBusy(true); setErr(null);
    const body = batch
      ? { batchId: batch.batchId, startDate: start, endDate: effEnd, type }
      : { costPersonId: personId, startDate: start, endDate: effEnd, type, halfDay: single && halfDay, hours: single && !halfDay && hours.trim() !== '' ? Number(hours) : undefined };
    try {
      const res = await fetch('/api/roster-leave', { method: batch ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || t('leave.error')); setBusy(false); return; }
      onDone(d, d?.message || '');
    } catch { setErr(t('leave.error')); setBusy(false); }
  }
  return (
    <div className="py-2 space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block text-xs text-muted mb-1">{t('leave.start')}</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} /></label>
        <label className="block"><span className="block text-xs text-muted mb-1">{t('leave.end')}</span>
          <input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} placeholder={start} className={inputCls} /></label>
        <label className="block"><span className="block text-xs text-muted mb-1">{t('leave.type')}</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
            {LEAVE_TYPES.map((k) => <option key={k} value={k}>{t(`type.${k}`)}</option>)}
          </select></label>
        {!batch && single && (
          <label className="flex items-center gap-1.5 pb-2 text-sm text-ink">
            <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)} /> {t('leave.halfDay')}
          </label>
        )}
        <button onClick={save} disabled={busy || !start} className={btnCls}>{busy ? t('leave.saving') : t('leave.save')}</button>
        <button onClick={onCancel} className="text-sm text-muted hover:text-ink px-2 py-2">{t('leave.cancel')}</button>
      </div>
      {!batch && single && !halfDay && (
        <label className="block text-xs text-muted">{t('leave.customHours')}{' '}
          <input type="number" step="0.25" min="0" value={hours} onChange={(e) => setHours(e.target.value)} className={`${inputCls} w-24 py-1 ml-1`} />
        </label>
      )}
      {err && <p className="text-sm text-danger">{err}</p>}
    </div>
  );
}

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
    } catch { setErr(t('allowance.error')); }
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
  const [tab, setTab] = useState<'leave' | 'holidays' | 'colours'>('leave');
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [roster, setRoster] = useState<Roster | null>(null);
  const [holidays, setHolidays] = useState<Holiday[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);   // personId with open add-form
  const [editing, setEditing] = useState<string | null>(null); // batchId being edited
  const [msg, setMsg] = useState<React.ReactNode | null>(null);
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

  // The skip-transparency banner: booked count + EVERY skipped day with its reason.
  const showResult = (r: SaveResult, fallback: string) => {
    const booked = r.booked?.length ?? 0;
    const skipped = r.skipped ?? [];
    if (!r.booked && !r.skipped) { setMsg(fallback || null); return; }
    setMsg(
      <span>
        {t('leave.bookedN', { count: booked })}
        {skipped.length > 0 && (
          <>
            {' '}{t('leave.skippedIntro')}{' '}
            {skipped.map((s2, i) => (
              <span key={s2.date}>{i > 0 && '; '}{fmtDay(s2.date)} — {t(`skip.${s2.reason}`)}</span>
            ))}
          </>
        )}
      </span>,
    );
  };
  const refresh = (r?: SaveResult, m?: string) => { setAdding(null); setEditing(null); if (r) showResult(r, m || ''); load(); };

  async function removeBooking(b: Booking) {
    setBusy(true);
    try {
      const body = b.batchId ? { batchId: b.batchId } : { id: b.rowId };
      const res = await fetch('/api/roster-leave', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  const groups = (() => {
    if (!roster) return [];
    const bySite = new Map<string | null, Person[]>();
    for (const p of roster.people) bySite.set(p.homeSiteId, [...(bySite.get(p.homeSiteId) ?? []), p]);
    const ordered: Array<{ key: string | null; name: string; people: Person[] }> = [];
    for (const s of roster.sites) if (bySite.has(s.id)) ordered.push({ key: s.id, name: s.name, people: bySite.get(s.id)! });
    if (bySite.has(null)) ordered.push({ key: null, name: t('unassigned'), people: bySite.get(null)! });
    return ordered;
  })();
  const singlePerson = roster && !roster.canWrite;

  const bookingLabel = (b: Booking, contracted: number | null) => {
    const range = b.dates.length > 1 ? `${fmtDay(b.dates[0])} – ${fmtDay(b.dates[b.dates.length - 1])}` : fmtDay(b.dates[0]);
    let size: string;
    if (b.dates.length > 1) size = t('leave.daysN', { count: b.dates.length });
    else if (b.hours == null) size = t('leave.fullDay');
    else if (contracted != null && Math.abs(b.hours - contracted / 2) < 0.01) size = t('leave.halfDay');
    else size = t('leave.hoursN', { n: b.hours });
    return `${range} · ${size}`;
  };

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
          {([...(['leave', 'holidays'] as const), ...(roster?.canEditAllowance ? (['colours'] as const) : [])]).map((k) => (
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
                      <div className="py-2 text-sm text-muted flex items-center gap-2">{t('allowance.label')}: <AllowanceEditor personId={p.id} initial={p.allowanceDays} t={t} onSaved={() => refresh()} /></div>
                    )}
                    {p.leave.length === 0 && <p className="text-sm text-muted py-2">{t('leave.none', { year })}</p>}
                    {groupBookings(p.leave).map((b) => {
                      const key = b.batchId ?? b.rowId;
                      return editing === key && b.batchId ? (
                        <LeaveForm key={key} personId={p.id} batch={{ batchId: b.batchId, start: b.dates[0], end: b.dates[b.dates.length - 1], type: b.type }} t={t} onDone={refresh} onCancel={() => setEditing(null)} />
                      ) : (
                        <div key={key} className="flex flex-wrap items-center gap-2 py-1.5 border-b border-line/40 last:border-0">
                          <span className="text-sm text-ink tabular-nums">{bookingLabel(b, p.contractedHoursPerDay)}</span>
                          <TypeChip type={b.type} colours={roster?.colours ?? DEFAULT_LEAVE_COLOURS} t={t} />
                          <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-ok-soft text-ok ml-auto">{t(`status.${b.status}`)}</span>
                          {p.editable && (
                            <>
                              {b.batchId && <button onClick={() => setEditing(key)} className="text-xs text-accent underline">{t('leave.edit')}</button>}
                              <button onClick={() => removeBooking(b)} disabled={busy} className="text-xs text-danger underline disabled:opacity-40">{t('leave.delete')}</button>
                            </>
                          )}
                        </div>
                      );
                    })}
                    {p.editable && (adding === p.id
                      ? <LeaveForm personId={p.id} t={t} onDone={refresh} onCancel={() => setAdding(null)} />
                      : <button onClick={() => setAdding(p.id)} className="mt-2 text-sm text-accent underline">{t('leave.add')}</button>)}
                  </div>
                </details>
              ))}
            </div>
          </div>
        ))}

        {tab === 'colours' && roster?.canEditAllowance && (
          <ColoursPanel colours={roster.colours ?? DEFAULT_LEAVE_COLOURS} t={t} onSaved={() => load()} />
        )}

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

// Admin colour remap (accessibility): per-type swatches over the Okabe–Ito defaults; stored on
// the Group, resolved server-side — the diary banners and chips read the same map.
function ColoursPanel({ colours, t, onSaved }: { colours: Record<string, string>; t: (k: string, o?: any) => string; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({ ...colours });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/roster', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaveColours: vals }) });
      const d = await res.json().catch(() => ({}));
      setMsg(d?.message || null);
      if (res.ok) onSaved();
    } catch { setMsg(t('colours.error')); }
    setBusy(false);
  }
  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      <p className="text-sm text-muted mb-3">{t('colours.intro')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        {LEAVE_TYPES.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm text-ink">
            <input type="color" value={vals[k] ?? DEFAULT_LEAVE_COLOURS[k as LeaveTypeKey]} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} className="w-9 h-7 p-0 border border-line rounded" />
            {t(`type.${k}`)}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className={btnCls}>{busy ? t('leave.saving') : t('colours.save')}</button>
        <button onClick={() => setVals({ ...DEFAULT_LEAVE_COLOURS })} className="text-sm text-muted underline">{t('colours.reset')}</button>
        {msg && <span className="text-sm text-muted">{msg}</span>}
      </div>
    </div>
  );
}

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
