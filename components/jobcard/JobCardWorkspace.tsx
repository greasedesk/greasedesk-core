/**
 * File: components/jobcard/JobCardWorkspace.tsx
 * The tabbed process-path workspace for a job card. Renders the mobile-first step strip, exactly ONE
 * pane at a time (no long phone scroll), and the audit foot pane. Active tab lives in the URL (?tab=)
 * so refresh/back/deep-link work. Every mutating control re-enforces server-side; the UI greying is
 * the same gating chokepoint (computeTabs) the APIs use, so it can never permit an out-of-order action.
 *
 * Tabs: Customer Details (edge-resolved owner) → Quote (renamed estimate + accept-&-book) → Intake →
 * In-Job → Completion photos (gated stages; upload is a placeholder until the R2 slice) → Invoice.
 */
import React, { useMemo, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import EstimateBuilder, { EstimateLine, CatalogueLite, FixedServiceLite, TierLite, EstimateHandle } from '@/components/jobcard/EstimateBuilder';
import JobCardNotes from '@/components/jobcard/JobCardNotes';
import CustomerDetailsForm from '@/components/jobcard/CustomerDetailsForm';
import JobCardTabs, { TabView } from '@/components/jobcard/JobCardTabs';
import JobCardAudit, { AuditEvent } from '@/components/jobcard/JobCardAudit';
import { JobStatus, StageKey } from '@/lib/jobcard-status';
import { TAB_KEYS, TabKey, TabState } from '@/lib/jobcard-tabs';
import { startTimeSlots } from '@/lib/booking-slots';
import { computeFootprint, Break } from '@/lib/occupancy';

type Resource = { id: string; name: string };
export type CardBooking = { resourceId: string; startAt: string; endAt: string; heldOnLift: boolean; workingMinutes: number } | null;

type Props = {
  jobCardId: string;
  status: JobStatus;
  tabsState: Record<TabKey, TabState>;
  canManage: boolean;     // commercial (status/accept/booking/invoice)
  canOperate: boolean;    // operational (stage ticks, notes, mileage, start work)
  canEditPricing: boolean;
  owner: { name: string; phone: string | null; email: string | null; address: string | null };
  vehicle: { registration: string; vin: string | null; mileageIn: number | null; mileageOut: number | null };
  flags: string[];
  garageNotes: string;
  currency: string; locale: string; vatRate: number; vatRegistered: boolean;
  lines: EstimateLine[]; catalogue: CatalogueLite[]; fixedServices: FixedServiceLite[]; tiers: TierLite[]; hasEstimate: boolean;
  resources: Resource[]; booking: CardBooking;
  siteHours: { openHour: number; closeHour: number; slotMinutes: number; openDays: number[]; breaks: Break[] };
  siteId: string;
  stages: Record<StageKey, boolean>;
  invoice: { id: string; number: string } | null;
  events: AuditEvent[];
};

const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const datePart = (iso: string) => iso.slice(0, 10);
const timePart = (iso: string) => iso.slice(11, 16);
const buildISO = (d: string, t: string) => `${d}T${t}:00.000Z`;

export default function JobCardWorkspace(p: Props) {
  const { t } = useTranslation('jobcard');
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const estimateRef = useRef<EstimateHandle>(null);
  const commitEstimate = () => estimateRef.current ? estimateRef.current.commit() : Promise.resolve({ ok: true as const });

  const cancelled = p.status === 'cancelled';

  // ----- active tab from URL, defaulting to the first reachable-incomplete step -----
  const firstOpen = useMemo(() => {
    const open = TAB_KEYS.find((k) => p.tabsState[k].reachable && !p.tabsState[k].complete);
    if (open) return open;
    const lastReachable = [...TAB_KEYS].reverse().find((k) => p.tabsState[k].reachable);
    return lastReachable ?? 'details';
  }, [p.tabsState]);
  const urlTab = (router.query.tab as string) as TabKey | undefined;
  const active: TabKey = urlTab && TAB_KEYS.includes(urlTab) && p.tabsState[urlTab].reachable ? urlTab : firstOpen;

  function selectTab(k: TabKey) {
    router.replace({ pathname: router.pathname, query: { ...router.query, tab: k } }, undefined, { shallow: true });
  }

  async function run(key: string, fn: () => Promise<Response>) {
    setBusy(key); setErr(null);
    try {
      const res = await fn();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data?.message || t('action.error')); return false; }
      router.replace(router.asPath); // refresh SSR-derived tab state + audit
      return true;
    } catch { setErr(t('action.error')); return false; }
    finally { setBusy(null); }
  }
  const postJSON = (url: string, body: unknown) => () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const setStage = (stage: StageKey, done: boolean) => run(`stage:${stage}`, postJSON('/api/jobcard-stage', { jobCardId: p.jobCardId, stage, done }));
  const setStatus = (to: JobStatus) => run(`status:${to}`, postJSON('/api/jobcard-status', { jobCardId: p.jobCardId, to }));

  const tabViews: TabView[] = TAB_KEYS.map((k) => ({ key: k, label: t(`tab.${k}`), reachable: p.tabsState[k].reachable, complete: p.tabsState[k].complete }));

  // ---------- panes ----------
  function StageComplete({ stage, label }: { stage: StageKey; label: string }) {
    const done = p.stages[stage];
    const detailsBlocked = stage === 'details' && !(p.owner.name && p.owner.name !== '—' && p.vehicle.registration && p.vehicle.registration !== '—');
    return (
      <button
        type="button"
        disabled={!p.canOperate || cancelled || busy !== null || (!done && detailsBlocked)}
        title={!done && detailsBlocked ? t('tab.detailsMinData') : undefined}
        onClick={() => setStage(stage, !done)}
        className={`w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 disabled:opacity-50 ${done ? 'bg-ok-soft text-ok border border-line' : 'bg-accent hover:bg-accent-hover text-white'}`}
      >
        {done ? t('stageComplete.doneToggle', { label }) : t('stageComplete.mark', { label })}
      </button>
    );
  }

  function PhotoPlaceholder() {
    return (
      <div className="border-2 border-dashed border-line rounded-xl p-8 text-center bg-surface-muted">
        <p className="text-sm text-muted">{t('photos.placeholder')}</p>
        <p className="text-xs text-muted mt-1">{t('photos.placeholderHint')}</p>
      </div>
    );
  }

  function DetailsPane() {
    return (
      <div className="space-y-5">
        <CustomerDetailsForm
          jobCardId={p.jobCardId}
          owner={p.owner}
          vehicle={p.vehicle}
          canEdit={p.canOperate && !cancelled}
          locale={p.locale}
          onSaved={() => router.replace(router.asPath)}
        />

        <div className="bg-surface border border-line rounded-xl p-5">
          <h3 className="text-sm font-semibold text-ink mb-3">{t('field.flags')}</h3>
          {p.flags.length ? (
            <div className="flex flex-wrap gap-2">
              {p.flags.map((f) => <span key={f} className="text-sm px-3 py-1 rounded-lg bg-accent text-white border border-accent">{t(`flag.${f}`)}</span>)}
            </div>
          ) : <p className="text-muted text-sm">{t('field.noFlags')}</p>}
        </div>

        <JobCardNotes jobCardId={p.jobCardId} canEdit={p.canOperate && !cancelled} initialNotes={p.garageNotes} />

        <div className="flex justify-end"><StageComplete stage="details" label={t('tab.details')} /></div>
      </div>
    );
  }

  function InvoicePane() {
    return (
      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <h2 className="text-lg font-semibold text-ink">{t('tab.invoice')}</h2>
        {p.invoice ? (
          <>
            <Link href={`/admin/invoices/${p.invoice.id}`} className="flex items-center justify-between gap-2 bg-accent-soft border border-line rounded-xl px-4 py-3 hover:bg-accent-soft/70">
              <span className="text-sm text-ink font-medium">{t('invoiceTab.number')} <span className="font-mono">{p.invoice.number}</span></span>
              <span className="text-sm text-accent">{t('invoiceTab.view')} →</span>
            </Link>
            {p.status === 'invoiced' && p.canManage && !cancelled && (
              <button disabled={busy !== null} onClick={() => setStatus('paid')} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.paid')}</button>
            )}
          </>
        ) : p.status === 'in_progress' && p.canManage && !cancelled ? (
          <>
            <p className="text-sm text-muted">{t('invoiceTab.readyToMint')}</p>
            <button disabled={busy !== null} onClick={() => setStatus('invoiced')} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.invoiced')}</button>
          </>
        ) : (
          <p className="text-sm text-muted">{t('invoiceTab.notYet')}</p>
        )}
      </div>
    );
  }

  return (
    <>
      {cancelled && <div className="bg-danger-soft text-danger rounded-xl px-4 py-3 mb-5 text-sm">{t('cancelledBanner')}</div>}
      <JobCardTabs tabs={tabViews} active={active} onSelect={selectTab} lockedReason={t('tab.locked')} />
      {err && <div className="bg-danger-soft text-danger rounded-lg p-3 text-sm mb-4">{err}</div>}

      {active === 'details' && <DetailsPane />}

      {active === 'quote' && (
        <div className="space-y-5">
          {/* Quote Actions sit ABOVE the estimate: act on the quote first, build/save the estimate below. */}
          <QuoteActions
            status={p.status} canManage={p.canManage && !cancelled} cancelled={cancelled}
            resources={p.resources} booking={p.booking} siteHours={p.siteHours} siteId={p.siteId} locale={p.locale} jobCardId={p.jobCardId} busy={busy} setBusy={setBusy} setErr={setErr}
            onDone={() => router.replace(router.asPath)} navigate={(url) => router.push(url)} t={t} setStatus={setStatus} commitEstimate={commitEstimate}
          />
          <EstimateBuilder ref={estimateRef} jobCardId={p.jobCardId} canEdit={p.canEditPricing && !cancelled} currency={p.currency} locale={p.locale} initialVatRate={p.vatRate} initialLines={p.lines} vatRegistered={p.vatRegistered} catalogue={p.catalogue} fixedServices={p.fixedServices} tiers={p.tiers} />
        </div>
      )}

      {active === 'intake' && (
        <div className="space-y-5">
          <PhotoPlaceholder />
          <div className="flex flex-wrap gap-3 justify-end">
            {p.status === 'accepted' && p.canOperate && !cancelled && (
              <button disabled={busy !== null} onClick={() => setStatus('in_progress')} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.in_progress')}</button>
            )}
            <StageComplete stage="intake" label={t('tab.intake')} />
          </div>
        </div>
      )}

      {active === 'injob' && (
        <div className="space-y-5">
          <PhotoPlaceholder />
          <div className="flex justify-end"><StageComplete stage="injob" label={t('tab.injob')} /></div>
        </div>
      )}

      {active === 'completion' && (
        <div className="space-y-5">
          <PhotoPlaceholder />
          <MileageOut jobCardId={p.jobCardId} initial={p.vehicle.mileageOut} canEdit={p.canOperate && !cancelled} busy={busy} setBusy={setBusy} setErr={setErr} onDone={() => router.replace(router.asPath)} t={t} mileageIn={p.vehicle.mileageIn} locale={p.locale} />
          <div className="flex justify-end"><StageComplete stage="complete" label={t('tab.completion')} /></div>
        </div>
      )}

      {active === 'invoice' && <InvoicePane />}

      <JobCardAudit events={p.events} />
    </>
  );
}

// ---------- Quote actions: mark-quoted / accept-&-book / reschedule / decline / cancel ----------
const HOURS_OPTS = Array.from({ length: 16 }, (_, i) => (i + 1) * 0.5); // 0.5 … 8.0
// Seed the hours picker from stored working-minutes: a clean half-hour ≤ 8h → a dropdown value; else Other.
function seedHours(wm: number): { sel: string; free: string } {
  if (wm > 0 && wm % 30 === 0 && wm <= 480) return { sel: String(wm / 60), free: '' };
  return { sel: 'other', free: wm > 0 ? String(Math.round((wm / 60) * 100) / 100) : '' };
}

function QuoteActions(props: {
  status: JobStatus; canManage: boolean; cancelled: boolean;
  resources: Resource[]; booking: CardBooking; siteHours: { openHour: number; closeHour: number; slotMinutes: number; openDays: number[]; breaks: Break[] }; siteId: string; locale: string; jobCardId: string;
  busy: string | null; setBusy: (s: string | null) => void; setErr: (s: string | null) => void; onDone: () => void; navigate: (url: string) => void;
  t: (k: string, o?: any) => string; setStatus: (to: JobStatus) => void; commitEstimate: () => Promise<{ ok: boolean; message?: string }>;
}) {
  const { status, canManage, resources, booking, siteHours, siteId, locale, jobCardId, busy, setBusy, setErr, onDone, navigate, t, commitEstimate } = props;
  const { openHour, closeHour, openDays, breaks } = siteHours;

  const slots = useMemo(() => startTimeSlots(openHour, closeHour, 15), [openHour, closeHour]);
  const seed = booking ? seedHours(booking.workingMinutes) : { sel: '1', free: '' };

  const [liftId, setLiftId] = useState(booking?.resourceId ?? '');
  const [startDate, setStartDate] = useState(booking ? datePart(booking.startAt) : '');
  const [startTime, setStartTime] = useState(booking ? timePart(booking.startAt) : (slots.includes('09:00') ? '09:00' : slots[0] ?? '08:00'));
  const [durSel, setDurSel] = useState(seed.sel);
  const [freeHours, setFreeHours] = useState(seed.free);

  const isBookingStage = status === 'quoted' || status === 'declined';
  const isAcceptedOnwards = ['accepted', 'in_progress', 'invoiced', 'paid', 'done'].includes(status);
  // The trade quotes in JOB-HOURS; duration → working-minutes feeds the unchanged footprint engine.
  const workingMinutes = durSel === 'other' ? Math.round((Number(freeHours) || 0) * 60) : Math.round(Number(durSel) * 60);
  const endISO = startDate && startTime && workingMinutes > 0 ? computeFootprint(buildISO(startDate, startTime), workingMinutes, openHour, closeHour, openDays, breaks).endISO : null;

  const endLabel = (iso: string) => {
    const d = new Date(iso);
    const wd = d.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${wd} ${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  };
  const liftName = () => resources.find((r) => r.id === liftId)?.name ?? t('booking.lift');
  const diaryUrl = `/admin/diary?site=${encodeURIComponent(siteId)}&view=week${startDate ? `&date=${startDate}` : ''}`;

  // Plain status/booking action (decline / cancel / unbook) — no estimate commit.
  async function call(key: string, url: string, method: string, body?: unknown) {
    setBusy(key); setErr(null);
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data?.code === 'CLASH' ? t('booking.couldntBook', { lift: liftName() }) : (data?.message || t('action.error'))); return; }
      onDone();
    } catch { setErr(t('action.error')); }
    finally { setBusy(null); }
  }

  // THE unified Save: commit the estimate FIRST (so it's never lost), then attempt the booking/status.
  // Partial success — if the estimate saves but the booking clashes, the estimate is already safe and
  // we report the booking failure; never a silent revert.
  async function saveAll(kind: 'estimate' | 'reschedule' | 'accept' | 'quoted', navigateAfter = false) {
    const needsBooking = kind === 'reschedule' || kind === 'accept';
    if (needsBooking && (!liftId || !startDate || !startTime || !(workingMinutes > 0))) { setErr(t('booking.needLiftAndTimes')); return; }
    setBusy('save'); setErr(null);
    const est = await commitEstimate();
    let secondOk = true, secondMsg = '';
    if (needsBooking) {
      const url = kind === 'accept' ? '/api/jobcard-accept' : '/api/diary';
      const method = kind === 'accept' ? 'POST' : 'PATCH';
      try {
        const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, resourceId: liftId, startAt: buildISO(startDate, startTime), workingMinutes }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { secondOk = false; secondMsg = d?.code === 'CLASH' ? t('booking.couldntBook', { lift: liftName() }) : (d?.message || t('action.error')); }
      } catch { secondOk = false; secondMsg = t('action.error'); }
    } else if (kind === 'quoted') {
      try {
        const r = await fetch('/api/jobcard-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, to: 'quoted' }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { secondOk = false; secondMsg = d?.message || t('action.error'); }
      } catch { secondOk = false; secondMsg = t('action.error'); }
    }
    setBusy(null);
    if (est.ok && secondOk) { navigateAfter ? navigate(diaryUrl) : onDone(); return; }
    if (est.ok && !secondOk) { setErr(t('booking.partialSaved', { msg: secondMsg })); onDone(); return; } // estimate safe; report the rest
    if (!est.ok && secondOk) { setErr(est.message || t('estimate.saveError')); return; }              // estimate failed — keep edits, no refresh
    setErr([est.message, secondMsg].filter(Boolean).join(' — '));
  }

  if (!canManage) return null;
  const canCancel = !['done', 'cancelled'].includes(status);
  const btn = 'text-sm font-semibold rounded-lg px-4 py-2.5 disabled:opacity-50';

  return (
    <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-ink">{t('quoteActions.title')}</h3>

      {(isBookingStage || isAcceptedOnwards) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs text-muted mb-1">{t('booking.lift')}</label>
            <select className={inputCls} value={liftId} onChange={(e) => setLiftId(e.target.value)}>
              <option value="">{t('booking.selectLift')}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">{t('booking.startDate')}</label>
            <input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">{t('booking.startTime')}</label>
            <select className={inputCls} value={startTime} onChange={(e) => setStartTime(e.target.value)}>
              {slots.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-muted mb-1">{t('booking.duration')}</label>
            <div className="flex gap-2">
              <select className={inputCls} value={durSel} onChange={(e) => setDurSel(e.target.value)}>
                {HOURS_OPTS.map((h) => <option key={h} value={String(h)}>{t('booking.durHours', { h })}</option>)}
                <option value="other">{t('booking.durOther')}</option>
              </select>
              {durSel === 'other' && (
                <input type="number" step="0.5" min="0" inputMode="decimal" className={inputCls} value={freeHours} onChange={(e) => setFreeHours(e.target.value)} placeholder={t('booking.durHoursPh')} />
              )}
            </div>
          </div>
          <div className="sm:col-span-2 text-sm text-muted">{endISO ? t('booking.endsAt', { when: endLabel(endISO) }) : t('booking.pickStart')}</div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        {status === 'draft' && (
          <>
            <button disabled={busy !== null} onClick={() => saveAll('estimate')} className={`${btn} bg-accent-soft text-accent`}>{t('quoteActions.save')}</button>
            <button disabled={busy !== null} onClick={() => saveAll('quoted')} className={`${btn} bg-accent hover:bg-accent-hover text-white`}>{t('action.quoted')}</button>
          </>
        )}
        {isBookingStage && (
          <>
            <button disabled={busy !== null} onClick={() => saveAll('accept')} className={`${btn} bg-accent hover:bg-accent-hover text-white`}>{t('quoteActions.acceptBook')}</button>
            <button disabled={busy !== null} onClick={() => saveAll('estimate')} className={`${btn} bg-accent-soft text-accent`}>{t('quoteActions.save')}</button>
            {status === 'quoted' && <button disabled={busy !== null} onClick={() => props.setStatus('declined')} className={`${btn} bg-surface-muted text-ink`}>{t('action.declined')}</button>}
          </>
        )}
        {isAcceptedOnwards && (
          <>
            <button disabled={busy !== null} onClick={() => saveAll('reschedule', true)} className={`${btn} bg-accent hover:bg-accent-hover text-white`}>{t('quoteActions.saveReturn')}</button>
            <button disabled={busy !== null} onClick={() => saveAll('reschedule')} className={`${btn} bg-accent-soft text-accent`}>{t('quoteActions.save')}</button>
            <button disabled={busy !== null} onClick={() => call('unbook', `/api/diary?jobCardId=${jobCardId}`, 'DELETE')} className={`${btn} bg-surface-muted text-ink`}>{t('booking.unbook')}</button>
          </>
        )}
        {canCancel && <button disabled={busy !== null} onClick={() => props.setStatus('cancelled')} className={`${btn} bg-danger-soft text-danger sm:ml-auto`}>{t('action.cancelled')}</button>}
      </div>
    </div>
  );
}

// ---------- Completion mileage-out (advisories grain seed) ----------
function MileageOut(props: { jobCardId: string; initial: number | null; canEdit: boolean; busy: string | null; setBusy: (s: string | null) => void; setErr: (s: string | null) => void; onDone: () => void; t: (k: string, o?: any) => string; mileageIn: number | null; locale: string }) {
  const { t } = props;
  const [val, setVal] = useState(props.initial != null ? String(props.initial) : '');
  const delta = props.mileageIn != null && val !== '' && Number.isFinite(Number(val)) ? Number(val) - props.mileageIn : null;
  async function save() {
    props.setBusy('mileage'); props.setErr(null);
    try {
      const res = await fetch('/api/jobcard-odometer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId: props.jobCardId, odometerOut: val }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { props.setErr(data?.message || t('action.error')); return; }
      props.onDone();
    } catch { props.setErr(t('action.error')); }
    finally { props.setBusy(null); }
  }
  return (
    <div className="bg-surface border border-line rounded-xl p-5">
      <h3 className="text-sm font-semibold text-ink mb-1">{t('completion.mileageOut')}</h3>
      <p className="text-xs text-muted mb-3">{t('completion.mileageHint')}</p>
      <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="flex-1">
          <input type="number" min="0" className={inputCls} value={val} disabled={!props.canEdit || props.busy !== null} onChange={(e) => setVal(e.target.value)} placeholder={t('completion.mileageOut')} />
          {delta != null && delta >= 0 && <p className="text-xs text-muted mt-1">{t('completion.delta', { miles: delta.toLocaleString(props.locale) })}</p>}
        </div>
        <button disabled={!props.canEdit || props.busy !== null} onClick={save} className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('completion.saveMileage')}</button>
      </div>
    </div>
  );
}
