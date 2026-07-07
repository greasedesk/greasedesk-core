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
import { PromoLite } from '@/lib/promo';
import JobCardNotes from '@/components/jobcard/JobCardNotes';
import CustomerDetailsForm from '@/components/jobcard/CustomerDetailsForm';
import PhotoStage from '@/components/jobcard/PhotoStage';
import JobCardTabs, { TabView } from '@/components/jobcard/JobCardTabs';
import JobCardAudit, { AuditEvent } from '@/components/jobcard/JobCardAudit';
import { JobStatus, StageKey } from '@/lib/jobcard-status';
import { TAB_KEYS, TabKey, TabState, computeTabs } from '@/lib/jobcard-tabs';
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
  vehicle: {
    registration: string; vin: string | null; mileageIn: number | null; mileageOut: number | null;
    make: string | null; model: string | null; colour: string | null; year: number | null; fuel: string | null; engineCc: number | null;
    motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null;
  };
  flags: string[];
  isComeback: boolean;
  garageNotes: string;
  currency: string; locale: string; vatRate: number; vatRegistered: boolean;
  lines: EstimateLine[]; catalogue: CatalogueLite[]; fixedServices: FixedServiceLite[]; tiers: TierLite[]; promos: PromoLite[]; hasEstimate: boolean;
  resources: Resource[]; booking: CardBooking;
  siteHours: { openHour: number; closeHour: number; slotMinutes: number; openDays: number[]; breaks: Break[] };
  siteId: string;
  stages: Record<StageKey, boolean>;
  skipped: { intake: boolean; injob: boolean; complete: boolean };
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

  // ---- OPTIMISTIC SAVE / NO FULL-PAGE REFRESH -------------------------------------------------
  // Mutations no longer router.replace(asPath) (a full 11-query gssp re-run — the save "blank").
  // Instead: an OVERLAY over the SSR props is patched optimistically at click time (tab gating
  // recomputed client-side with the SAME computeTabs chokepoint, so greying still can't drift from
  // the server), the API call runs in the background, and on success ONE narrow request to
  // /api/jobcard-pane quietly reconciles everything (audit, invoice number, server-derived state).
  // On failure the overlay reverts to its pre-click snapshot + a friendly error. Server-side save
  // logic (validation/guards/audit/money) is byte-identical — this is client data flow only.
  type Overlay = {
    status?: JobStatus;
    stages?: Record<StageKey, boolean>;
    skipped?: { intake: boolean; injob: boolean; complete: boolean };
    isComeback?: boolean;
    invoice?: { id: string; number: string } | null;
    events?: AuditEvent[];
    booking?: CardBooking;
    tabsState?: Record<TabKey, TabState>;
    vehicle?: Props['vehicle'];
    owner?: Props['owner'];
  };
  const [ov, setOv] = useState<Overlay>({});
  const eff = {
    status: ov.status ?? p.status,
    stages: ov.stages ?? p.stages,
    skipped: ov.skipped ?? p.skipped,
    isComeback: ov.isComeback ?? p.isComeback,
    invoice: ov.invoice !== undefined ? ov.invoice : p.invoice,
    events: ov.events ?? p.events,
    booking: ov.booking !== undefined ? ov.booking : p.booking,
    tabsState: ov.tabsState ?? p.tabsState,
    vehicle: ov.vehicle ?? p.vehicle,
    owner: ov.owner ?? p.owner,
  };
  // Client-side twin of the SSR gating inputs (reconciled by refreshCard; server still enforces).
  const clientTabs = (patch: Partial<Overlay>) => computeTabs({
    status: (patch.status ?? eff.status) as JobStatus,
    stages: patch.stages ?? eff.stages,
    skipped: patch.skipped ?? eff.skipped,
    hasOwner: !!(eff.owner.name && eff.owner.name !== '—'),
    hasRegistration: !!(eff.vehicle.registration && eff.vehicle.registration !== '—'),
  });
  async function refreshCard() {
    try {
      const res = await fetch(`/api/jobcard-pane?id=${encodeURIComponent(p.jobCardId)}`, { cache: 'no-store' });
      if (!res.ok) return; // quiet — the optimistic state stands; a manual reload reconciles
      const d = await res.json();
      setOv({
        status: d.status, stages: d.stages, skipped: d.skipped, isComeback: d.isComeback,
        invoice: d.invoice, events: d.events, booking: d.booking, tabsState: d.tabsState,
        vehicle: d.vehicle, owner: d.owner,
      });
    } catch { /* quiet */ }
  }

  const cancelled = eff.status === 'cancelled';

  // ----- active tab from URL, defaulting to the first reachable-incomplete step -----
  const firstOpen = useMemo(() => {
    const open = TAB_KEYS.find((k) => eff.tabsState[k].reachable && !eff.tabsState[k].complete);
    if (open) return open;
    const lastReachable = [...TAB_KEYS].reverse().find((k) => eff.tabsState[k].reachable);
    return lastReachable ?? 'details';
  }, [eff.tabsState]);
  const urlTab = (router.query.tab as string) as TabKey | undefined;
  const active: TabKey = urlTab && TAB_KEYS.includes(urlTab) && eff.tabsState[urlTab].reachable ? urlTab : firstOpen;

  function selectTab(k: TabKey) {
    router.replace({ pathname: router.pathname, query: { ...router.query, tab: k } }, undefined, { shallow: true });
  }

  async function run(key: string, fn: () => Promise<Response>, optimistic?: Partial<Overlay>) {
    const snapshot = ov; // revert point — honest reconcile on failure
    if (optimistic) setOv((prev) => ({ ...prev, ...optimistic }));
    setBusy(key); setErr(null);
    try {
      const res = await fn();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setOv(snapshot); setErr(data?.message || t('action.error')); return false; }
      refreshCard(); // ONE narrow background request — no route transition, no page blank
      return true;
    } catch { setOv(snapshot); setErr(t('action.error')); return false; }
    finally { setBusy(null); }
  }
  const postJSON = (url: string, body: unknown) => () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const setStage = (stage: StageKey, done: boolean) => {
    const stages = { ...eff.stages, [stage]: done };
    const skipped = stage !== 'details' && done ? { ...eff.skipped, [stage]: false } : eff.skipped; // done wins
    return run(`stage:${stage}`, postJSON('/api/jobcard-stage', { jobCardId: p.jobCardId, stage, done }),
      { stages, skipped, tabsState: clientTabs({ stages, skipped }) });
  };
  const setSkip = (stage: StageKey, skipTo: boolean, reason?: string) => {
    const skipped = { ...eff.skipped, [stage === 'complete' ? 'complete' : stage]: skipTo } as Overlay['skipped'];
    return run(`skip:${stage}`, postJSON('/api/jobcard-stage', { jobCardId: p.jobCardId, stage, done: skipTo, skip: true, reason: reason || undefined }),
      { skipped, tabsState: clientTabs({ skipped }) });
  };
  const setStatus = (to: JobStatus) =>
    run(`status:${to}`, postJSON('/api/jobcard-status', { jobCardId: p.jobCardId, to }),
      { status: to, tabsState: clientTabs({ status: to }) });
  const setComeback = (v: boolean) =>
    run(`comeback:${v}`, () => fetch('/api/jobcard-comeback', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId: p.jobCardId, isComeback: v }) }),
      { isComeback: v });

  // ---- PRE-MINT VIN/MILEAGE BACKSTOP (prompt-and-skip, never a block) ----
  // State lives HERE (not in the nested pane component) so optimistic re-renders can't wipe it.
  // Missing fields → inline add-now inputs OR "skip and invoice anyway"; the server audits any
  // mint that proceeds without the data (invoice.vin_skipped / invoice.mileage_skipped), so the
  // trail exists regardless of which client invoices.
  const [mintOpen, setMintOpen] = useState(false);
  const [mintVin, setMintVin] = useState('');
  const [mintMileage, setMintMileage] = useState('');
  const mintVinMissing = !(eff.vehicle.vin && eff.vehicle.vin.trim());
  const mintMileageMissing = eff.vehicle.mileageIn == null;
  const mintMissing = [mintVinMissing && t('field.vin'), mintMileageMissing && t('field.mileage')].filter(Boolean) as string[];
  const startMint = () => { if (mintMissing.length) { setMintOpen(true); } else { setStatus('invoiced'); } };
  async function addAndMint() {
    const vehicle: Record<string, string> = {};
    if (mintVinMissing && mintVin.trim()) vehicle.vin = mintVin.trim();
    if (mintMileageMissing && mintMileage.trim() !== '') vehicle.mileageIn = mintMileage.trim();
    setBusy('mint'); setErr(null);
    try {
      if (Object.keys(vehicle).length) {
        const r = await fetch('/api/jobcard-details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId: p.jobCardId, vehicle }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setErr(d?.message || t('action.error')); setBusy(null); return; }
      }
      setBusy(null); setMintOpen(false); setMintVin(''); setMintMileage('');
      await setStatus('invoiced');
    } catch { setErr(t('action.error')); setBusy(null); }
  }
  const skipAndMint = () => { setMintOpen(false); setStatus('invoiced'); };

  const tabViews: TabView[] = TAB_KEYS.map((k) => ({ key: k, label: t(`tab.${k}`), reachable: eff.tabsState[k].reachable, complete: eff.tabsState[k].complete, skipped: eff.tabsState[k].skipped }));

  // ---------- panes ----------
  function StageComplete({ stage, label }: { stage: StageKey; label: string }) {
    const done = eff.stages[stage];
    const skippable = stage !== 'details'; // Details is a data gate — never skippable
    const isSkipped = skippable && !done && eff.skipped[stage === 'complete' ? 'complete' : stage as 'intake' | 'injob'];
    const [skipOpen, setSkipOpen] = useState(false);
    const [skipReason, setSkipReason] = useState('');
    const detailsBlocked = stage === 'details' && !(p.owner.name && p.owner.name !== '—' && p.vehicle.registration && p.vehicle.registration !== '—');
    return (
      <div className="flex flex-col items-stretch sm:items-end gap-2">
        <div className="flex flex-wrap gap-2 justify-end">
          {/* Soft gate: skipped state — audited; undo re-opens the stage. */}
          {isSkipped ? (
            <button type="button" disabled={!p.canOperate || cancelled || busy !== null} onClick={() => setSkip(stage, false)}
              className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-warn-soft text-warn border border-line disabled:opacity-50">
              {t('stageSkip.skippedToggle', { label })}
            </button>
          ) : (
            <>
              {skippable && !done && p.canOperate && !cancelled && !skipOpen && (
                <button type="button" disabled={busy !== null} onClick={() => setSkipOpen(true)}
                  className="w-full sm:w-auto text-sm rounded-lg px-4 py-2.5 border border-line text-muted hover:text-ink disabled:opacity-50">
                  {t('stageSkip.button')}
                </button>
              )}
              <button
                type="button"
                disabled={!p.canOperate || cancelled || busy !== null || (!done && detailsBlocked)}
                title={!done && detailsBlocked ? t('tab.detailsMinData') : undefined}
                onClick={() => setStage(stage, !done)}
                className={`w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 disabled:opacity-50 ${done ? 'bg-ok-soft text-ok border border-line' : 'bg-accent hover:bg-accent-hover text-white'}`}
              >
                {done ? t('stageComplete.doneToggle', { label }) : t('stageComplete.mark', { label })}
              </button>
            </>
          )}
        </div>
        {skipOpen && !isSkipped && (
          <div className="flex flex-wrap gap-2 items-center justify-end">
            <input value={skipReason} onChange={(e) => setSkipReason(e.target.value)} placeholder={t('stageSkip.reasonPh')}
              className="flex-1 min-w-[10rem] p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm" />
            <button type="button" disabled={busy !== null} onClick={() => { setSkip(stage, true, skipReason); setSkipOpen(false); setSkipReason(''); }}
              className="text-sm font-semibold rounded-lg px-3 py-2 bg-warn-soft text-warn border border-line disabled:opacity-50">{t('stageSkip.confirm')}</button>
            <button type="button" onClick={() => { setSkipOpen(false); setSkipReason(''); }} className="text-sm text-muted hover:text-ink px-2">{t('delete.cancel')}</button>
          </div>
        )}
      </div>
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
          onSaved={refreshCard}
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
    // Which stages still block the all_stages_done gate (done OR skipped advances; Details is
    // done-only). Same inputs computeTabs reads — guidance can't drift from the server's refusal.
    const remaining = [
      !eff.stages.details && ('details' as const),
      !eff.stages.intake && !eff.skipped.intake && ('intake' as const),
      !eff.stages.injob && !eff.skipped.injob && ('injob' as const),
      !eff.stages.complete && !eff.skipped.complete && ('completion' as const),
    ].filter(Boolean) as Array<'details' | 'intake' | 'injob' | 'completion'>;
    const allAdvanced = remaining.length === 0;
    const preInvoice = ['draft', 'quoted', 'declined', 'accepted', 'in_progress'].includes(eff.status);

    // TWO explicit audited clicks (ruling): Start work (→ in_progress, operational — anchors the
    // future clocking/labour-actuals grain) then Mark invoiced (→ invoiced, commercial). Both live
    // here so nobody hunts back to the Intake tab; the server still gates every move.
    const startWorkBtn = eff.status === 'accepted' && allAdvanced && p.canOperate && !cancelled && (
      <>
        <p className="text-sm text-muted">{t('invoiceTab.readyToStart')}</p>
        <button disabled={busy !== null} onClick={() => setStatus('in_progress')} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.in_progress')}</button>
      </>
    );
    const stagesRemainingMsg = !allAdvanced && preInvoice && !cancelled && (
      <p className="text-sm text-muted">{t('invoiceTab.stagesRemaining', { list: remaining.map((k) => t(`tab.${k}`)).join(', ') })}</p>
    );
    // Last-chance VIN/mileage prompt — only for what's actually missing; skip always available.
    const mintPanel = mintOpen && (
      <div className="bg-warn-soft border border-line rounded-xl p-4 space-y-3">
        <p className="text-sm text-warn font-medium">{t('invoiceTab.missingTitle', { list: mintMissing.join(', ') })}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {mintVinMissing && (
            <input value={mintVin} onChange={(e) => setMintVin(e.target.value)} placeholder={t('field.vin')} maxLength={17}
              className="p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm" />
          )}
          {mintMileageMissing && (
            <input type="number" inputMode="numeric" min={0} value={mintMileage} onChange={(e) => setMintMileage(e.target.value)} placeholder={t('field.mileage')}
              className="p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm" />
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <button disabled={busy !== null || (!(mintVinMissing && mintVin.trim()) && !(mintMileageMissing && mintMileage.trim()))} onClick={addAndMint}
            className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('invoiceTab.addAndInvoice')}</button>
          <button disabled={busy !== null} onClick={skipAndMint}
            className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-surface border border-line text-ink disabled:opacity-50">{t('invoiceTab.skipAndInvoice')}</button>
          <button onClick={() => setMintOpen(false)} className="text-sm text-muted hover:text-ink px-2 py-2.5">{t('delete.cancel')}</button>
        </div>
      </div>
    );

    return (
      <div className="bg-surface border border-line rounded-xl p-5 space-y-4">
        <h2 className="text-lg font-semibold text-ink">{t('tab.invoice')}</h2>
        {eff.isComeback ? (
          // Comeback ON the spine: same invoiced/paid transitions as any card, but the £0 invoice
          // mints from the WARRANTY series — a chargeable number is never used.
          <>
            <div className="bg-warn-soft text-warn rounded-lg px-3 py-2 text-sm">{t('comeback.invoiceNote')}</div>
            {eff.invoice && (
              <Link href={`/admin/invoices/${eff.invoice.id}`} className="flex items-center justify-between gap-2 bg-accent-soft border border-line rounded-xl px-4 py-3 hover:bg-accent-soft/70">
                <span className="text-sm text-ink font-medium">{t('invoiceTab.number')} <span className="font-mono">{eff.invoice.number}</span></span>
                <span className="text-sm text-accent">{t('invoiceTab.view')} →</span>
              </Link>
            )}
            {startWorkBtn}
            {eff.status === 'in_progress' && allAdvanced && p.canManage && !cancelled && !mintOpen && (
              <button disabled={busy !== null} onClick={startMint} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('comeback.markInvoiced')}</button>
            )}
            {mintPanel}
            {eff.status === 'invoiced' && p.canManage && !cancelled && (
              <button disabled={busy !== null} onClick={() => setStatus('paid')} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.paid')}</button>
            )}
            {stagesRemainingMsg}
          </>
        ) : eff.invoice ? (
          <>
            <Link href={`/admin/invoices/${eff.invoice.id}`} className="flex items-center justify-between gap-2 bg-accent-soft border border-line rounded-xl px-4 py-3 hover:bg-accent-soft/70">
              <span className="text-sm text-ink font-medium">{t('invoiceTab.number')} <span className="font-mono">{eff.invoice.number}</span></span>
              <span className="text-sm text-accent">{t('invoiceTab.view')} →</span>
            </Link>
            {eff.status === 'invoiced' && p.canManage && !cancelled && (
              <button disabled={busy !== null} onClick={() => setStatus('paid')} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.paid')}</button>
            )}
          </>
        ) : eff.status === 'in_progress' && allAdvanced && p.canManage && !cancelled ? (
          <>
            <p className="text-sm text-muted">{t('invoiceTab.readyToMint')}</p>
            {!mintOpen && (
              <button disabled={busy !== null} onClick={startMint} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.invoiced')}</button>
            )}
            {mintPanel}
          </>
        ) : startWorkBtn ? (
          startWorkBtn
        ) : stagesRemainingMsg ? (
          stagesRemainingMsg
        ) : (
          <p className="text-sm text-muted">{t('invoiceTab.notYet')}</p>
        )}
      </div>
    );
  }

  return (
    <>
      {cancelled && <div className="bg-danger-soft text-danger rounded-xl px-4 py-3 mb-5 text-sm">{t('cancelledBanner')}</div>}
      {eff.isComeback && <div className="bg-warn-soft text-warn rounded-xl px-4 py-3 mb-5 text-sm">{t('comeback.banner')}</div>}
      <JobCardTabs tabs={tabViews} active={active} onSelect={selectTab} lockedReason={t('tab.locked')} />
      {err && <div className="bg-danger-soft text-danger rounded-lg p-3 text-sm mb-4">{err}</div>}

      {active === 'details' && <DetailsPane />}

      {active === 'quote' && (
        <div className="space-y-5">
          {/* Quote Actions sit ABOVE the estimate: act on the quote first, build/save the estimate below. */}
          <QuoteActions
            status={eff.status} canManage={p.canManage && !cancelled} cancelled={cancelled}
            resources={p.resources} booking={eff.booking} siteHours={p.siteHours} siteId={p.siteId} locale={p.locale} jobCardId={p.jobCardId} busy={busy} setBusy={setBusy} setErr={setErr}
            onDone={refreshCard} navigate={(url) => router.push(url)} t={t} setStatus={setStatus} commitEstimate={commitEstimate}
          />
          <EstimateBuilder ref={estimateRef} jobCardId={p.jobCardId} canEdit={p.canEditPricing && !cancelled} currency={p.currency} locale={p.locale} initialVatRate={p.vatRate} initialLines={p.lines} vatRegistered={p.vatRegistered} catalogue={p.catalogue} fixedServices={p.fixedServices} tiers={p.tiers} promos={p.promos} />
          {/* Warranty/comeback — a mechanic knows a job came back → operational (any assigned user).
              Makes the job zero-revenue for reporting (drag = parts cost only); the estimate lines stay
              intact as the true cost. It invoices at £0 on the warranty series (see the Invoice tab). */}
          {p.canOperate && !cancelled && (
            <label className="flex items-start gap-3 bg-surface border border-line rounded-xl p-4 text-sm cursor-pointer">
              <input type="checkbox" className="w-5 h-5 mt-0.5" checked={eff.isComeback} disabled={busy !== null} onChange={(e) => setComeback(e.target.checked)} />
              <span><span className="font-semibold text-ink">{t('comeback.label')}</span><span className="block text-xs text-muted mt-0.5">{t('comeback.hint')}</span></span>
            </label>
          )}
        </div>
      )}

      {active === 'intake' && (
        <div className="space-y-5">
          <PhotoStage jobCardId={p.jobCardId} stage="intake" canEdit={p.canOperate && !cancelled} locked={eff.stages.intake} locale={p.locale} />
          <div className="flex justify-end"><StageComplete stage="intake" label={t('tab.intake')} /></div>
        </div>
      )}

      {active === 'injob' && (
        <div className="space-y-5">
          {/* Start-work lives HERE on the spine — after Intake, before In-Job photos (which evidence
              the work). SOFT: a guide, not a gate — stages tick in any order; the Invoice-tab rescue
              remains the backstop. in_progress anchors the future clocking/labour-actuals grain. */}
          {eff.status === 'accepted' && p.canOperate && !cancelled && (
            <div className="bg-accent-soft border border-line rounded-xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-sm text-ink">{t('startWork.hint')}</p>
              <button disabled={busy !== null} onClick={() => setStatus('in_progress')} className="w-full sm:w-auto shrink-0 text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.in_progress')}</button>
            </div>
          )}
          <PhotoPlaceholder />
          <div className="flex justify-end"><StageComplete stage="injob" label={t('tab.injob')} /></div>
        </div>
      )}

      {active === 'completion' && (
        <div className="space-y-5">
          <PhotoPlaceholder />
          <MileageOut jobCardId={p.jobCardId} initial={p.vehicle.mileageOut} canEdit={p.canOperate && !cancelled} busy={busy} setBusy={setBusy} setErr={setErr} onDone={refreshCard} t={t} mileageIn={p.vehicle.mileageIn} locale={p.locale} />
          <div className="flex justify-end"><StageComplete stage="complete" label={t('tab.completion')} /></div>
        </div>
      )}

      {active === 'invoice' && <InvoicePane />}

      <JobCardAudit events={eff.events} />
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
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{t('quoteActions.title')}</h3>
        {/* Booked-at-a-glance lives HERE, beside the booking fields — not as a phantom tab
            (the standalone strip chip was removed; booking is part of the Quote). */}
        <span className={`text-xs font-medium rounded-full px-2.5 py-1 ${booking ? 'bg-ok-soft text-ok' : 'bg-surface-muted text-muted'}`}>
          {booking ? `✓ ${t('booking.booked')}` : t('booking.notBookedShort')}
        </span>
      </div>

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
