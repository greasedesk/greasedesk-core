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
import React, { useMemo, useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import EstimateBuilder, { EstimateLine, CatalogueLite, FixedServiceLite, TierLite, EstimateHandle } from '@/components/jobcard/EstimateBuilder';
import { PromoLite } from '@/lib/promo';
import { lineFlags, toPlausible, partsProfit } from '@/lib/line-plausibility';
import { diaryReturnHref } from '@/lib/diary-return';
import JobCardNotes from '@/components/jobcard/JobCardNotes';
import CustomerDetailsForm from '@/components/jobcard/CustomerDetailsForm';
import ConversationView, { type ConversationMessage, type Reachability } from '@/components/messages/ConversationView';
import PhotoStage from '@/components/jobcard/PhotoStage';
import JobCardTabs, { TabView } from '@/components/jobcard/JobCardTabs';
import JobCardAudit, { AuditEvent } from '@/components/jobcard/JobCardAudit';
import { JobStatus, StageKey } from '@/lib/jobcard-status';
import { TAB_KEYS, TabKey, TabState, computeTabs } from '@/lib/jobcard-tabs';
import { startTimeSlots } from '@/lib/booking-slots';
import { computeFootprint, Break } from '@/lib/occupancy';
import { lookupKeyFor, isPlausibleVin, type LookupProviderName } from '@/lib/vehicle-lookup-providers';
import type { PriceUnconfirmed } from '@/lib/quotes-list';
import { formatMoney } from '@/lib/format-money';

type Resource = { id: string; name: string };
export type CardBooking = { resourceId: string; startAt: string; endAt: string; heldOnLift: boolean; workingMinutes: number } | null;

/** The mismatch between what was BILLED and what was later agreed. Shaped by lib/jobcard-page-data;
 *  present only where there is a real correction to offer, and only for an admin. */
export type AgreedVersionFix = {
  versionId: string;
  sentVersion: number; sentPennies: number;
  agreedVersion: number; agreedPennies: number;
  /** Named in the confirm so it reads as a conversation the mechanic actually had. */
  customerName?: string | null;
  differencePennies: number;
  agreedProvenance: 'customer' | 'garage' | 'unknown';
  /** FALSE = no invoice yet. There is then no second step: the invoice is simply raised at the
   *  agreed figure, and the control must not send anyone looking for an unlock button. */
  invoiced: boolean;
  invoiceNumber: string | null;
};

type Props = {
  jobCardId: string;
  status: JobStatus;
  tabsState: Record<TabKey, TabState>;
  canManage: boolean;     // commercial (status/accept/booking/invoice)
  canIssueInvoice: boolean; // may RAISE the invoice (in_progress→invoiced) — canManage OR the per-user grant
  canOperate: boolean;    // operational (stage ticks, notes, mileage, start work)
  canEditPricing: boolean;
  quoteFrozen: boolean; // freeze-at-issue: the invoice's lines exist, so the estimate is locked
  quoteSupersededNoLink: boolean; // latest quote version is superseded → no live customer link
  quoteSendBlockedReason: string | null; // server-computed: why no quote can be sent (null = it can)
  /** WHO confirmed the acceptance, in words. Null before anything is accepted. */
  acceptanceNote: string | null;
  acceptanceLabel: string | null;
  /** Present only for an ADMIN on a card invoiced against an EARLIER accepted version than the
   *  latest one still sent. Both totals are shaped server-side so the control states the money it
   *  is about to change rather than computing it client-side. */
  agreedVersionFix: AgreedVersionFix | null;
  quoteHasAcceptedVersion: boolean; // a version was ACCEPTED → the next send is a revision, not a quote
  priceUnconfirmed: PriceUnconfirmed | null; // agreed one price, sent another (lib/quotes-list)
  isAdmin: boolean;       // ADMIN — may author the catalogue (surfaces the ad-hoc "Add to catalogue" link)
  priceVisible: boolean; costVisible: boolean; // finance-shaped server-side (props already stripped)
  owner: { name: string; phone: string | null; phoneE164?: string | null; email: string | null; address: string | null; smsOptOut?: boolean | null; emailOptOut?: boolean | null };
  // Message history for this card's (customer, vehicle) thread — server-resolved.
  conversation?: ConversationMessage[];
  threadId?: string | null;
  reachability?: Reachability | null;
  vehicle: {
    registration: string; vin: string | null; mileageIn: number | null; mileageOut: number | null;
    make: string | null; model: string | null; colour: string | null; year: number | null; fuel: string | null; engineCc: number | null;
    motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null;
  };
  flags: string[];
  isComeback: boolean;
  // Duplicate provenance (both nullable/absent on ordinary cards). ownershipChanged drives the
  // prominent vehicle-reowned notice; costsInherited drives the Quote-tab stale-cost advisory.
  duplicatedFrom?: { registration: string | null; ownershipChanged: boolean; previousCustomerName: string | null } | null;
  // Country-shaped vehicle identity (ruling 2026-07-29) — label + whether a lookup provider exists.
  vehicleIdLabel?: string;
  vehicleLookupProvider?: LookupProviderName;
  costsInherited?: boolean;
  garageNotes: string;
  currency: string; locale: string; vatRate: number; vatRegistered: boolean;
  lines: EstimateLine[]; catalogue: CatalogueLite[]; fixedServices: FixedServiceLite[]; tiers: TierLite[]; promos: PromoLite[]; hasEstimate: boolean;
  labourRate?: number | null;
  resources: Resource[]; booking: CardBooking;
  siteHours: { openHour: number; closeHour: number; slotMinutes: number; openDays: number[]; breaks: Break[] };
  siteId: string;
  stages: Record<StageKey, boolean>;
  skipped: { intake: boolean; injob: boolean; complete: boolean };
  invoice: { id: string; number: string; status?: 'issued' | 'paid_pending' | 'paid' } | null;
  events: AuditEvent[];
};

const inputCls = 'w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const datePart = (iso: string) => iso.slice(0, 10);
const timePart = (iso: string) => iso.slice(11, 16);
const buildISO = (d: string, t: string) => `${d}T${t}:00.000Z`;

export default function JobCardWorkspace(p: Props) {
  const { t } = useTranslation('jobcard');
  const router = useRouter();
  // The thread as the SERVER last returned it. Seeded from props; replaced wholesale by the send
  // response so the list always shows what the log holds, never a local guess.
  const [convo, setConvo] = useState<ConversationMessage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const estimateRef = useRef<EstimateHandle>(null);
  const commitEstimate = () => estimateRef.current ? estimateRef.current.commit() : Promise.resolve({ ok: true as const });
  // Duplicated-card advisory: server state at load, dropped live once any save lands (the server
  // clears costs_inherited in the same write — this only mirrors it, never decides it).
  const [inheritedCleared, setInheritedCleared] = useState(false);

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
    invoice?: { id: string; number: string; status?: 'issued' | 'paid_pending' | 'paid' } | null;
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

  // THE one test every quote-write path uses. canEditPricing is a PERMISSION; quoteFrozen is the
  // freeze-at-issue lock. Before this the browser only had the first, so the autosave, the
  // tab-change commit and the route-leave commit all fired at a frozen card and collected 409s —
  // and the tab-change commit BLOCKS on failure, so the pane stopped swapping.
  const quoteEditable = p.canEditPricing && !cancelled && !p.quoteFrozen;

  async function selectTab(k: TabKey) {
    // Leaving the Quote step: PERSIST the estimate first, so a financial edit is never lost when
    // moving to another step. (Bug: the quote lived in EstimateBuilder's transient local state, which
    // unmounted on step change — the entered quotation silently vanished.) Blocking on failure: keep
    // the user on the Quote rather than advance and lose the data.
    if (active === 'quote' && k !== 'quote' && quoteEditable) {
      const r = await commitEstimate();
      // A TERMINAL refusal (409: the invoice froze under us) must not trap the operator on this
      // tab — the save will never succeed, so blocking only makes the page feel broken. Say what
      // happened and let them move. A transient failure (500, offline) still blocks, because there
      // the edit is worth keeping them here to retry.
      if (!r.ok && r.terminal) { setErr(r.message || t('estimate.saveError')); }
      else if (!r.ok) { setErr(r.message || t('estimate.saveError')); return; }
      else await refreshCard();
    }
    router.replace({ pathname: router.pathname, query: { ...router.query, tab: k } }, undefined, { shallow: true });
  }
  // Belt-and-braces: navigating AWAY from the card entirely (sidebar, back) while on the Quote step —
  // best-effort persist so the estimate survives leaving the page. Shallow (tab) changes are handled
  // by selectTab above; skip them here to avoid a double-commit.
  const activeTabRef = useRef<TabKey>('details');
  activeTabRef.current = active;
  const quoteEditableRef = useRef(false);
  quoteEditableRef.current = quoteEditable;
  useEffect(() => {
    const onLeave = (_url: string, opts?: { shallow?: boolean }) => {
      if (opts?.shallow) return;
      if (activeTabRef.current === 'quote' && quoteEditableRef.current) void commitEstimate();
    };
    router.events.on('routeChangeStart', onLeave);
    return () => router.events.off('routeChangeStart', onLeave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Client twin of the server's soft auto-advance: in-job/completion activity on an accepted card
  // moves it to in_progress (the server does this authoritatively in the same tx; this keeps the
  // optimistic overlay honest until refreshCard reconciles).
  const autoAdvanceStatus = (stage: StageKey, done: boolean): JobStatus | undefined =>
    eff.status === 'accepted' && done && (stage === 'injob' || stage === 'complete') ? 'in_progress' : undefined;
  const setStage = (stage: StageKey, done: boolean) => {
    const stages = { ...eff.stages, [stage]: done };
    const skipped = stage !== 'details' && done ? { ...eff.skipped, [stage]: false } : eff.skipped; // done wins
    const status = autoAdvanceStatus(stage, done);
    return run(`stage:${stage}`, postJSON('/api/jobcard-stage', { jobCardId: p.jobCardId, stage, done }),
      { stages, skipped, ...(status ? { status } : {}), tabsState: clientTabs({ stages, skipped, ...(status ? { status } : {}) }) });
  };
  const setSkip = (stage: StageKey, skipTo: boolean, reason?: string) => {
    const skipped = { ...eff.skipped, [stage === 'complete' ? 'complete' : stage]: skipTo } as Overlay['skipped'];
    const status = autoAdvanceStatus(stage, skipTo);
    return run(`skip:${stage}`, postJSON('/api/jobcard-stage', { jobCardId: p.jobCardId, stage, done: skipTo, skip: true, reason: reason || undefined }),
      { skipped, ...(status ? { status } : {}), tabsState: clientTabs({ skipped, ...(status ? { status } : {}) }) });
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
  // Surface 2 — pre-issue plausibility summary. Issue freezes the lines (only unlock→reissue reverses
  // it), so this is the last cheap moment to catch a price-in-quantity or a loss-making line. Advisory:
  // the panel requires acknowledgement (proceed), never a correction — the line may be legitimate.
  // Pre-issue plausibility, computed from the LIVE estimate lines at click time (the estimate stays
  // mounted across tabs, so the ref is valid here). Reading p.lines — the page's load-time snapshot —
  // would miss a bad line added in the SAME session, which is exactly the case this guards. Falls back
  // to p.lines only if the ref is somehow absent. Invoice-level parts profit only asserts a loss when a
  // costed parts line exists; null-cost lines are excluded (unknown ≠ zero) and flagged incomplete.
  type PreIssue = { flags: Array<{ i: number; l: EstimateLine; flags: ReturnType<typeof lineFlags> }>; pp: ReturnType<typeof partsProfit>; loss: boolean };
  const [preIssue, setPreIssue] = useState<PreIssue | null>(null);
  const startMint = () => {
    const live = estimateRef.current?.lines() ?? p.lines;
    const flags = live.map((l, i) => ({ i, l, flags: lineFlags(toPlausible(l), { postedLabourRate: p.labourRate ?? null }) })).filter((x) => x.flags.length > 0);
    const pp = partsProfit(live.map((l) => toPlausible(l)));
    const loss = pp.hasParts && pp.profitPennies < 0;
    if (mintMissing.length || flags.length || loss) { setPreIssue({ flags, pp, loss }); setMintOpen(true); }
    else { setStatus('invoiced'); }
  };
  async function addAndMint() {
    const vehicle: Record<string, string> = {};
    if (mintVinMissing && mintVin.trim()) vehicle.vin = mintVin.trim();
    if (mintMileageMissing && mintMileage.trim() !== '') vehicle.mileageIn = mintMileage.trim();
    setBusy('mint'); setErr(null);
    try {
      if (Object.keys(vehicle).length) {
        const r = await fetch('/api/jobcard-details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId: p.jobCardId, vehicle, source: 'pre-mint-backstop' }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setErr(d?.message || t('action.error')); setBusy(null); return; }
      }
      setBusy(null); setMintOpen(false); setMintVin(''); setMintMileage('');
      await setStatus('invoiced');
    } catch { setErr(t('action.error')); setBusy(null); }
  }
  const skipAndMint = () => { setMintOpen(false); setStatus('invoiced'); };

  // ---- MARK-PAID METHOD PICKER (required — the method is the grain; no silent default) ----
  // State hoisted (remount rule). Behaviour drives clearance server-side: instant/windowed/manual.
  const [payOpen, setPayOpen] = useState(false);
  const [payMethods, setPayMethods] = useState<Array<{ id: string; name: string; behaviour: string }> | null>(null);
  const [payMethodId, setPayMethodId] = useState('');
  const [payDate, setPayDate] = useState(''); // the DOCUMENT payment date (Xero-style pick)
  async function openPay() {
    setPayDate(new Date().toISOString().slice(0, 10)); // defaults to today; editable
    setPayOpen(true);
    if (!payMethods) {
      try {
        const r = await fetch('/api/payment-methods', { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          setPayMethods(d.methods || []);
          const pre = (d.methods || []).find((m: any) => m.behaviour === 'windowed') ?? (d.methods || [])[0];
          if (pre) setPayMethodId(pre.id);
        }
      } catch { /* the select shows empty; server still validates */ }
    }
  }
  const confirmPay = () => {
    if (!payMethodId || !payDate) return;
    setPayOpen(false);
    run('status:paid', postJSON('/api/jobcard-status', { jobCardId: p.jobCardId, to: 'paid', paymentMethodId: payMethodId, datePaid: payDate }),
      { status: 'paid', tabsState: clientTabs({ status: 'paid' }) });
  };

  // Email-invoice from the Invoice tab — SAME endpoint as the view page (one send path, no fork).
  // State hoisted here (never inside a pane — remount rule). Success refreshes the audit foot.
  const [emailMsg, setEmailMsg] = useState<{ text: string; ok: boolean } | null>(null);
  async function emailInvoice() {
    if (!eff.invoice) return;
    setBusy('invoice-email'); setEmailMsg(null);
    try {
      const res = await fetch('/api/invoice-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: eff.invoice.id }) });
      const d = await res.json().catch(() => ({}));
      setEmailMsg(res.ok ? { text: t('invoiceTab.emailSent'), ok: true } : { text: d?.message || t('invoiceTab.emailError'), ok: false });
      if (res.ok) refreshCard();
    } catch { setEmailMsg({ text: t('invoiceTab.emailError'), ok: false }); }
    finally { setBusy(null); }
  }

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

  // PLAIN JSX, not a nested component: a function defined in the render body gets a NEW identity
  // every parent re-render, so React REMOUNTS the whole subtree — that wiped the details form's
  // state right after Save (the reconcile's setOv re-rendered the parent, the form remounted and
  // re-initialised from stale page-load props → "DVSA values cleared"). Inline JSX keeps child
  // element types stable across renders; the form's state now survives overlay updates. Props come
  // from eff.* (the reconciled overlay), so a genuine remount re-initialises with the FRESHEST data.
  const detailsPane = (
      <div className="space-y-5">
        <CustomerDetailsForm
          vehicleIdLabel={p.vehicleIdLabel}
          vehicleLookupProvider={p.vehicleLookupProvider}
          jobCardId={p.jobCardId}
          owner={eff.owner}
          vehicle={eff.vehicle}
          canEdit={p.canOperate && !cancelled}
          locale={p.locale}
          onSaved={refreshCard}
        />

        {/* THE CONVERSATION — on the customer record, read-only in this slice. */}
        <div className="bg-surface border border-line rounded-xl p-5">
          <ConversationView
            messages={convo ?? p.conversation ?? []}
            locale={p.locale}
            heading={t('messages.heading')}
            dense
            threadId={p.threadId ?? null}
            jobCardId={p.jobCardId}
            reachability={p.reachability ?? null}
            canSend={p.canOperate && !cancelled}
            onSent={setConvo}
          />
        </div>

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

  // INLINE JSX via IIFE, not a nested component (remount rule — the DVSA lesson, second offender):
  // the mint/pay prompt state is hoisted to the workspace, so typing re-renders the workspace; a
  // nested component's identity changes each render and REMOUNTS the pane — losing input focus on
  // every keystroke. An IIFE evaluates to plain JSX with stable child types: no remount, focus holds.
  const invoicePane = (() => {
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

    // BACKSTOP only (ruling 2026-07-07): the normal path enters in_progress at the In-Job stage
    // (Start-work button there + server auto-advance on in-job/completion activity), so a card
    // reaching Invoice still `accepted` is an anomaly — a muted note + secondary button, never a
    // prescribed "start work then invoice" step.
    const startWorkBtn = eff.status === 'accepted' && allAdvanced && p.canOperate && !cancelled && (
      <>
        <p className="text-sm text-muted">{t('invoiceTab.neverStarted')}</p>
        <button disabled={busy !== null} onClick={() => setStatus('in_progress')} className="w-full sm:w-auto text-sm rounded-lg px-4 py-2.5 bg-surface border border-line text-ink disabled:opacity-50">{t('action.in_progress')}</button>
      </>
    );
    const stagesRemainingMsg = !allAdvanced && preInvoice && !cancelled && (
      <p className="text-sm text-muted">{t('invoiceTab.stagesRemaining', { list: remaining.map((k) => t(`tab.${k}`)).join(', ') })}</p>
    );
    // THE AGREED-VERSION CORRECTION, wherever the invoice link renders (normal + comeback). Absent
    // unless the server shaped a real mismatch for an admin — no client-side eligibility logic.
    // The `.invoiced` gate is GONE. The panel has always carried copy for the not-yet-invoiced case
    // — "The invoice will be raised at the OLD agreed price" — and that branch could never render,
    // so the one warning designed for the moment the estimate diverges was invisible at exactly that
    // moment. It is also the moment the mechanic can still fix it in one click, before a number is
    // burned. (Until estimate-save minted a revision there was nothing to compare either, so both
    // halves had to change together.)
    const agreedVersionPanel = p.agreedVersionFix && !cancelled && (
      <AgreedVersionFixPanel
        jobCardId={p.jobCardId} fix={p.agreedVersionFix} disabled={busy !== null}
        currency={p.currency} locale={p.locale} onDone={refreshCard}
      />
    );
    // Email-invoice action + paid-lifecycle state, shown wherever the invoice link renders
    // (normal + comeback). Pending = amber, reversible, silently unmarkable; never the PAID face.
    const invoiceActions = eff.invoice && (
      <>
        {eff.invoice.status === 'paid_pending' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold rounded-full px-2.5 py-1 bg-warn-soft text-warn">{t('invoiceTab.pendingChip')}</span>
            {p.canManage && !cancelled && (
              <button disabled={busy !== null}
                onClick={() => { if (window.confirm(t('invoiceTab.unmarkConfirm'))) run('unmark-paid', postJSON('/api/invoice-unmark-paid', { invoiceId: eff.invoice!.id }), { status: 'invoiced', invoice: { ...eff.invoice!, status: 'issued' }, tabsState: clientTabs({ status: 'invoiced' }) }); }}
                className="text-xs rounded-lg px-3 py-1.5 border border-line text-warn hover:bg-warn-soft disabled:opacity-50">
                {t('invoiceTab.unmark')}
              </button>
            )}
          </div>
        )}
        {eff.invoice.status === 'paid' && (
          <span className="self-start text-xs font-semibold rounded-full px-2.5 py-1 bg-ok-soft text-ok">{t('invoiceTab.paidChip')}</span>
        )}
        {p.canManage && !cancelled && (
          <button disabled={busy !== null} onClick={emailInvoice}
            className="w-full sm:w-auto text-sm rounded-lg px-4 py-2.5 bg-surface border border-line text-ink hover:bg-surface-muted disabled:opacity-50">
            {busy === 'invoice-email' ? t('invoiceTab.emailSending') : t('invoiceTab.emailSend')}
          </button>
        )}
        {emailMsg && <div className={`rounded-lg p-2 text-sm ${emailMsg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{emailMsg.text}</div>}
      </>
    );
    // Method picker for Mark paid — required choice, pre-selected to the first windowed method.
    const payPanel = payOpen && (
      <div className="bg-surface-muted border border-line rounded-xl p-4 space-y-3">
        <p className="text-sm font-medium text-ink">{t('invoiceTab.payMethodTitle')}</p>
        <select value={payMethodId} onChange={(e) => setPayMethodId(e.target.value)}
          className="w-full sm:w-64 p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm">
          {(payMethods ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} — {t(`invoiceTab.clearance.${m.behaviour}`)}</option>)}
        </select>
        <label className="block">
          <span className="block text-xs text-muted mb-1">{t('invoiceTab.payDateLabel')}</span>
          <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)}
            className="w-full sm:w-64 p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm" />
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <button disabled={busy !== null || !payMethodId || !payDate} onClick={confirmPay}
            className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.paid')}</button>
          <button onClick={() => setPayOpen(false)} className="text-sm text-muted hover:text-ink px-2 py-2.5">{t('delete.cancel')}</button>
        </div>
      </div>
    );
    // Last-chance VIN/mileage prompt — only for what's actually missing; skip always available.
    const flagReason = (f: ReturnType<typeof lineFlags>[number], l: EstimateLine) =>
      f.rule === 'B' ? t('estimate.warnPriceInQty', { qty: Number(l.qty) })
      : f.rule === 'E' ? t('estimate.warnQtyImplausible', { qty: Number(l.qty) })
      : f.rule === 'A' ? t('estimate.warnQtyHigh', { qty: Number(l.qty) })
      // Labour price-shaped rules (warn-only, no fix — the hours cannot be inferred).
      : f.rule === 'L1' ? (f.rate == null
          ? t('estimate.warnLabourFloor', { price: f.price.toFixed(2) })
          : t('estimate.warnLabourRate', { price: f.price.toFixed(2), rate: f.rate.toFixed(2), total: (Number(l.qty) * f.price).toFixed(2) }))
      : f.rule === 'L2' ? t('estimate.warnLabourHours', { qty: f.qty, price: f.price.toFixed(2), rate: f.rate.toFixed(2) })
      : t('estimate.warnCostOverRetail', { cost: f.cost.toFixed(2), retail: f.retail.toFixed(2) });
    const gbp = (pennies: number) => (pennies / 100).toFixed(2);
    const mintPanel = mintOpen && (
      <div className="bg-warn-soft border border-line rounded-xl p-4 space-y-3">
        {mintMissing.length > 0 && (
          <>
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
          </>
        )}
        {(preIssue?.flags.length ?? 0) > 0 && (
          <div className="space-y-1">
            <p className="text-sm text-warn font-medium">{t('invoiceTab.plausTitle')}</p>
            <ul className="text-xs text-warn space-y-1">
              {preIssue!.flags.map(({ i, l, flags }) => (
                <li key={i}>⚠ <span className="text-ink">{(l.description || '').split('\n')[0].trim() || t('estimate.parts')}</span> — {flags.map((f) => flagReason(f, l)).join(' ')}</li>
              ))}
            </ul>
          </div>
        )}
        {preIssue?.loss && (
          <p className="text-sm text-warn">⚠ {t('invoiceTab.partsLoss', { revenue: gbp(preIssue.pp.retailPennies), cost: gbp(preIssue.pp.costPennies), loss: gbp(-preIssue.pp.profitPennies) })}
            {preIssue.pp.nullCostLines > 0 && <span className="block text-xs">{t('invoiceTab.partsLossIncomplete', { count: preIssue.pp.nullCostLines })}</span>}
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          {mintMissing.length > 0 && (
            <button disabled={busy !== null || (!(mintVinMissing && mintVin.trim()) && !(mintMileageMissing && mintMileage.trim()))} onClick={addAndMint}
              className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('invoiceTab.addAndInvoice')}</button>
          )}
          <button disabled={busy !== null} onClick={skipAndMint}
            className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-surface border border-line text-ink disabled:opacity-50">{mintMissing.length > 0 ? t('invoiceTab.skipAndInvoice') : t('invoiceTab.plausAck')}</button>
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
            {invoiceActions}
            {agreedVersionPanel}
            {startWorkBtn}
            {eff.status === 'in_progress' && allAdvanced && p.canIssueInvoice && !cancelled && !mintOpen && (
              <button disabled={busy !== null} onClick={startMint} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('comeback.markInvoiced')}</button>
            )}
            {mintPanel}
            {eff.status === 'invoiced' && p.canManage && !cancelled && !payOpen && (
              <button disabled={busy !== null} onClick={openPay} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.paid')}</button>
            )}
            {payPanel}
            {stagesRemainingMsg}
          </>
        ) : eff.invoice ? (
          <>
            <Link href={`/admin/invoices/${eff.invoice.id}`} className="flex items-center justify-between gap-2 bg-accent-soft border border-line rounded-xl px-4 py-3 hover:bg-accent-soft/70">
              <span className="text-sm text-ink font-medium">{t('invoiceTab.number')} <span className="font-mono">{eff.invoice.number}</span></span>
              <span className="text-sm text-accent">{t('invoiceTab.view')} →</span>
            </Link>
            {invoiceActions}
            {agreedVersionPanel}
            {eff.status === 'invoiced' && p.canManage && !cancelled && !payOpen && (
              <button disabled={busy !== null} onClick={openPay} className="w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">{t('action.paid')}</button>
            )}
            {payPanel}
          </>
        ) : eff.status === 'in_progress' && allAdvanced && p.canIssueInvoice && !cancelled ? (
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
  })();

  return (
    <>
      {cancelled && <div className="bg-danger-soft text-danger rounded-xl px-4 py-3 mb-5 text-sm">{t('cancelledBanner')}</div>}
      {eff.isComeback && <div className="bg-warn-soft text-warn rounded-xl px-4 py-3 mb-5 text-sm">{t('comeback.banner')}</div>}
      {/* Ownership moved since the source card — its own PROMINENT notice, never a clause on the
          cost line (amendment 2026-07-28): a skimmer of the cost advisory must still see this. */}
      {p.duplicatedFrom?.ownershipChanged && p.duplicatedFrom.previousCustomerName && (
        <div className="bg-warn-soft border border-warn text-warn rounded-xl px-4 py-3 mb-5 text-sm font-semibold" data-testid="dup-owner-notice">
          {t('duplicate.ownerChanged', { current: eff.owner.name, previous: p.duplicatedFrom.previousCustomerName })}
        </div>
      )}
      <JobCardTabs tabs={tabViews} active={active} onSelect={selectTab} lockedReason={t('tab.locked')} />
      {err && <div className="bg-danger-soft text-danger rounded-lg p-3 text-sm mb-4">{err}</div>}

      {active === 'details' && detailsPane}

      {/* The Quote section stays MOUNTED across steps (hidden when inactive) so its in-progress
          estimate state is never destroyed by a step change — the root of the "quote lost on next
          screen" bug. Persistence to the DB is handled by selectTab / route-away commits above. */}
      <div className={active === 'quote' ? 'space-y-5' : 'hidden'}>
          {/* Quote Actions sit ABOVE the estimate: act on the quote first, build/save the estimate below. */}
          <QuoteActions
            status={eff.status} canManage={p.canManage && !cancelled} cancelled={cancelled}
            resources={p.resources} booking={eff.booking} siteHours={p.siteHours} siteId={p.siteId} locale={p.locale} currency={p.currency} jobCardId={p.jobCardId} busy={busy} setBusy={setBusy} setErr={setErr}
            onDone={refreshCard} navigate={(url) => router.push(url)} t={t} setStatus={setStatus} commitEstimate={commitEstimate}
            quoteSupersededNoLink={p.quoteSupersededNoLink}
            quoteSendBlockedReason={p.quoteSendBlockedReason}
            acceptanceNote={p.acceptanceNote}
            acceptanceLabel={p.acceptanceLabel}
            agreedVersionFix={p.agreedVersionFix}
            quoteHasAcceptedVersion={p.quoteHasAcceptedVersion}
            quoteFrozen={p.quoteFrozen}
            priceUnconfirmed={p.priceUnconfirmed}
          />
          {/* THE UI'S OWN STATEMENT, from its own flag — not the 409 body echoed back. Before this
              the only "frozen" wording in the app lived in the API refusal, so the page could not
              say why the quote was read-only without first making a request that would fail. */}
          {p.quoteFrozen && (
            <div className="bg-warn-soft border border-warn rounded-xl p-3 mb-3 text-sm text-warn">
              {t('estimate.frozen')}
            </div>
          )}
          {/* Stale-cost advisory (duplicated card): the numbers below came from another card and may
              be weeks old. Advisory, never a gate — cleared by the first estimate save. Kept apart
              from the ownership notice above by design (amendment 2026-07-28). */}
          {p.costsInherited && !inheritedCleared && (
            <div className="bg-accent-soft border border-line rounded-xl p-3 mb-3 text-sm text-ink" data-testid="dup-costs-notice">
              {t('duplicate.costsInherited', { reg: p.duplicatedFrom?.registration ?? '' })}
            </div>
          )}
          <EstimateBuilder ref={estimateRef} jobCardId={p.jobCardId} canEdit={quoteEditable} currency={p.currency} locale={p.locale} initialVatRate={p.vatRate} labourRate={p.labourRate} initialLines={p.lines} vatRegistered={p.vatRegistered} catalogue={p.catalogue} fixedServices={p.fixedServices} tiers={p.tiers} promos={p.promos} priceVisible={p.priceVisible} costVisible={p.costVisible} canCatalogue={p.isAdmin} onSaved={() => setInheritedCleared(true)} />
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
          <PhotoStage jobCardId={p.jobCardId} stage="injob" canEdit={p.canOperate && !cancelled} locked={eff.stages.injob} locale={p.locale} />
          <div className="flex justify-end"><StageComplete stage="injob" label={t('tab.injob')} /></div>
        </div>
      )}

      {active === 'completion' && (
        <div className="space-y-5">
          <PhotoStage jobCardId={p.jobCardId} stage="completion" canEdit={p.canOperate && !cancelled} locked={eff.stages.complete} locale={p.locale} />
          <MileageOut jobCardId={p.jobCardId} initial={p.vehicle.mileageOut} canEdit={p.canOperate && !cancelled} busy={busy} setBusy={setBusy} setErr={setErr} onDone={refreshCard} t={t} mileageIn={p.vehicle.mileageIn} locale={p.locale} />
          <div className="flex justify-end"><StageComplete stage="complete" label={t('tab.completion')} /></div>
        </div>
      )}

      {active === 'invoice' && invoicePane}

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
  quoteSupersededNoLink: boolean;
  quoteSendBlockedReason: string | null;
  acceptanceNote: string | null;
  acceptanceLabel: string | null;
  agreedVersionFix: AgreedVersionFix | null;
  quoteHasAcceptedVersion: boolean;
  quoteFrozen: boolean;
  priceUnconfirmed: PriceUnconfirmed | null;
  currency: string;
}) {
  const { status, canManage, resources, booking, siteHours, siteId, locale, jobCardId, busy, setBusy, setErr, onDone, navigate, t, commitEstimate } = props;
  const { openHour, closeHour, openDays, breaks } = siteHours;
  // Read the diary context the user arrived with (?view/?date) so "back to the diary" returns to
  // the day they were on, not merely the day this card sits on.
  const router = useRouter();

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
  // Was: hardcoded view=week and keyed only on the booking form's LOCAL startDate — so it ignored
  // the day and view the user actually came from, and landed on today whenever the card was
  // unplaced (startDate empty). Same helper as the header link now, so both agree.
  // startDate is still the fallback: on this tab it IS the day the card sits on, and it tracks an
  // edit in progress, which is the useful behaviour while placing a job.
  const diaryUrl = diaryReturnHref({
    siteId,
    view: router.query.view,
    viewedDate: router.query.date,
    cardStartAt: startDate || null,
  });

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
    const bookingReady = !!liftId && !!startDate && !!startTime && workingMinutes > 0;
    setBusy('save'); setErr(null);
    // Commit the estimate FIRST, ALWAYS — a financial edit must NEVER be lost to a booking-field
    // guard. (Bug: the guard used to `return` here BEFORE this commit, so clicking "Save" on an
    // accepted-but-unbooked card silently discarded the quote edit while only showing a booking error.)
    const est = await commitEstimate();
    let secondOk = true, secondMsg = '';
    if (needsBooking && !bookingReady) {
      // Estimate is already saved; the booking simply still needs a lift + time. Report it, don't lose the quote.
      secondOk = false; secondMsg = t('booking.needLiftAndTimes');
    } else if (needsBooking) {
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
  const fmtMoney = (pennies: number) => formatMoney(pennies, { currency: props.currency, locale: props.locale });
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

      {/* SEND QUOTE TO CUSTOMER (slice-2a). Freezes the estimate as a version, mints a 14-day
          magic link and emails it. The URL is ALWAYS shown afterwards so it can be handed over by
          hand — WhatsApp, read out over the phone — and a customer with no email on file is
          offered the link rather than blocked. */}
      {/* DEAD-QUOTE FLAG: the estimate was materially edited after sending and never re-sent, so the
          customer's link no longer opens. State the fact and the remedy; it clears when a fresh quote
          is sent. Not shown once the card has moved on to accepted/onwards. */}
      {/* SHOWN WHEREVER THE ESTIMATE IS STILL EDITABLE. It used to be hidden once the card reached
          `accepted`, which is precisely when it matters most: parts get added mid-job, the edit
          supersedes the quote and revokes the customer's link, and the screen said nothing at all —
          no notice and no remedy. `quoteFrozen` is the honest boundary: once the invoice exists the
          lines are locked and there is nothing left to re-quote. */}
      {/* ── AGREED ONE PRICE, SENT ANOTHER ────────────────────────────────────────────────────
          The exposure, in figures, beside the superseded warning. "Awaiting approval" would state
          nothing; the two totals and the difference state exactly what is at risk, and it is
          recoverable until the car leaves. Derived ONCE in lib/quotes-list — never here. */}
      {props.priceUnconfirmed && (
        <div className="mt-4 rounded-lg border border-warn bg-warn-soft p-3" data-testid="price-unconfirmed">
          <p className="text-sm font-semibold text-warn">
            Agreed {fmtMoney(props.priceUnconfirmed.agreedPennies)} (v{props.priceUnconfirmed.agreedVersion}),
            {' '}sent {fmtMoney(props.priceUnconfirmed.sentPennies)} (v{props.priceUnconfirmed.sentVersion})
            {' — '}{props.priceUnconfirmed.differencePennies >= 0 ? '+' : '−'}
            {fmtMoney(Math.abs(props.priceUnconfirmed.differencePennies))} not yet agreed.
          </p>
          <p className="text-xs text-warn mt-0.5">
            The customer has not answered the new price. Worth settling before the car goes back.
          </p>
        </div>
      )}

      {/* THE REMEDY, directly beneath the warning that states the problem — on an UNINVOICED card
          this is where a garage settles it. The warning has existed for a while with nothing to
          click: KR60LCX sat in_progress with seven lines of work in the bay, an accepted v2 £156.00
          lower, and an invoice that would have billed the smaller figure. Stating an exposure and
          offering no way to close it is how that happens. */}
      {props.agreedVersionFix && !props.agreedVersionFix.invoiced && !props.cancelled && (
        <div className="mt-3">
          <AgreedVersionFixPanel
            jobCardId={jobCardId} fix={props.agreedVersionFix} disabled={busy !== null}
            currency={props.currency} locale={props.locale} onDone={props.onDone}
          />
        </div>
      )}

      {!props.quoteFrozen && !props.cancelled && props.quoteSupersededNoLink && (
        <p className="mt-4 text-sm text-warn">
          {props.quoteHasAcceptedVersion
            ? 'The price changed after this was agreed — the customer’s link no longer opens. Send them the new price.'
            : 'Superseded — customer can no longer view this quote. Send a new one.'}
        </p>
      )}

      {/* GATED ON WHETHER THE CARD COULD ANSWER (2026-08-08). It used to be gated only on the
          freeze and on cancellation, deliberately — but that let the control stand on a card whose
          quote could no longer be accepted, and offering to send a price nobody can say yes to is
          the same trap in a quieter form. `quoteSendBlockedReason` is computed SERVER-SIDE from the
          predicate the API refuses with, so the button is never offered where the send would 409.
          It also covers cancelled and invoiced, but those guards stay: they answer a different
          question (is this panel live at all?) and must not depend on this one. */}
      {!props.quoteFrozen && !props.cancelled && !props.quoteSendBlockedReason && (
        <SendQuote jobCardId={jobCardId} disabled={busy !== null} beforeSend={commitEstimate}
          revision={props.quoteHasAcceptedVersion} currency={props.currency} locale={props.locale} />
      )}

      {/* The reason, where the button was. Absent controls need an explanation or they read as a
          bug — and this one is a real decision the garage may want to act on. */}
      {!props.quoteFrozen && !props.cancelled && props.quoteSendBlockedReason && (
        <p className="mt-4 pt-4 border-t border-line text-sm text-muted" data-testid="quote-send-blocked">
          {props.quoteSendBlockedReason}
        </p>
      )}

      {/* ACCEPTANCE TAKEN BY PHONE. Distinct from the customer clicking their own link: the record
          captures WHO on staff marked it and that it was verbal, and deliberately records NO ip or
          user-agent — those would describe the receptionist, not the customer. */}
      {/* WHO CONFIRMED IT, in words (ruling 2026-08-08). A garage-recorded acceptance must SAY so —
          it used to be distinguishable only by a missing IP on a row nobody renders, and by whether a
          staff name happened to appear in the audit list. An absence is not a statement. */}
      {props.acceptanceLabel && props.acceptanceNote && (
        <div className="mt-4 pt-4 border-t border-line" data-testid="acceptance-provenance">
          <p className="text-sm font-medium text-ink">{props.acceptanceLabel}</p>
          <p className="text-xs text-muted mt-0.5">{props.acceptanceNote}</p>
        </div>
      )}

      {!isAcceptedOnwards && <AcceptVerbal jobCardId={jobCardId} disabled={busy !== null} />}
    </div>
  );
}

/**
 * THE AGREED-VERSION CORRECTION. Admin-only, on the INVOICE step, because correcting an invoice is
 * what it is for — putting it on Quote would file a money change under quoting.
 *
 * IT STATES THE MONEY BEFORE IT COMMITS (ruling): old total, new total, signed difference, and which
 * version. Both figures come from the server; this component does no arithmetic it would then ask
 * someone to authorise.
 *
 * TWO STEPS, NOT ONE. Recording the agreement does NOT unlock or re-issue. On success it says so —
 * an invoice still showing the old figures is the honest intermediate state, not a failure.
 */
function AgreedVersionFixPanel({ jobCardId, fix, disabled, currency, locale, onDone }: {
  jobCardId: string; fix: AgreedVersionFix; disabled: boolean; currency: string; locale: string; onDone: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const m = (p: number) => formatMoney(p, { currency, locale });
  const up = fix.differencePennies >= 0;

  async function record() {
    // PLAIN-SPOKEN ON SCREEN, PRECISE IN THE RECORD. The mechanic is asked about a price and a
    // customer; the row that lands says which version, who recorded it, and that no customer
    // signed anything (responded_by_user set, IP null — lib/acceptance-provenance).
    if (!window.confirm(
      `Confirm that ${fix.customerName ?? 'the customer'} agreed the new price of ${m(fix.sentPennies)}?\n\n`
      + `Recorded as agreed by the garage — we log who confirmed it and when.\n\n`
      + (fix.invoiced
        ? `Invoice ${fix.invoiceNumber ?? ''} has already been raised at ${m(fix.agreedPennies)}. You will need to unlock and re-issue it to bill the new price.`
        : `This job will then invoice at ${m(fix.sentPennies)} instead of ${m(fix.agreedPennies)}.`),
    )) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch('/api/quote-agreed-version', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, versionId: fix.versionId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || 'Could not record the agreed version.'); return; }
      setMsg(d.message);
      onDone();
    } catch { setErr('Could not record the agreed version.'); }
    finally { setBusy(false); } // never strand the busy flag
  }

  return (
    <div className="border border-warn rounded-xl p-4 bg-warn-soft" data-testid="agreed-version-fix">
      {/* Money, not vocabulary. A mechanic should never need to know what a quote version is to
          bill an extra hour he has already agreed on the phone. */}
      <p className="text-sm font-semibold text-warn">
        {fix.invoiced
          ? `This invoice was raised at ${m(fix.agreedPennies)}, but the job now comes to ${m(fix.sentPennies)}`
          : `This job now comes to ${m(fix.sentPennies)} — the agreed price is ${m(fix.agreedPennies)}`}
      </p>
      <dl className="mt-2 text-sm text-ink space-y-1">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">{fix.invoiced ? `Invoiced from v${fix.agreedVersion}` : `Agreed, v${fix.agreedVersion}`}</dt>
          <dd className="tabular-nums font-medium" data-testid="fix-agreed">{m(fix.agreedPennies)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Latest quote sent, v{fix.sentVersion}</dt>
          <dd className="tabular-nums font-medium" data-testid="fix-sent">{m(fix.sentPennies)}</dd>
        </div>
        <div className="flex justify-between gap-3 pt-1 border-t border-warn">
          <dt className="font-semibold">Difference</dt>
          <dd className="tabular-nums font-semibold" data-testid="fix-difference">
            {up ? '+' : '−'}{m(Math.abs(fix.differencePennies))}
          </dd>
        </div>
      </dl>
      {!msg && (
        <button type="button" disabled={disabled || busy} onClick={record}
          className="mt-3 w-full sm:w-auto text-sm font-semibold rounded-lg px-4 py-2.5 bg-surface border border-line text-ink disabled:opacity-50">
          {busy ? 'Recording…' : `Record that the customer agreed v${fix.sentVersion} by phone`}
        </button>
      )}
      <p className="mt-2 text-xs text-muted">
        {fix.invoiced
          ? 'Logged as a garage-recorded agreement, not a customer-signed one. Recording it does not change the invoice — unlock and re-issue it afterwards to bill the agreed figures.'
          /* THE FACT THAT COSTS MONEY, said plainly. Editing the estimate does not fix this: the
             invoice is a column-copy of the agreed version and never reads the estimate. */
          : 'This job has an agreed quote, so the invoice will be built from that version — adding lines to the estimate will not change it. Record the agreed version to bill the newer figure. Logged as a garage-recorded agreement, not a customer-signed one.'}
      </p>
      {msg && <p className="mt-2 text-sm text-ok" data-testid="fix-done">{msg}</p>}
      {err && <p className="mt-2 text-sm text-danger" data-testid="fix-error">{err}</p>}
    </div>
  );
}

function AcceptVerbal({ jobCardId, disabled }: { jobCardId: string; disabled: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  async function mark() {
    if (!window.confirm('Record that the customer confirmed this quote by phone? This is logged as a garage-recorded acceptance, not a customer-signed one.')) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch('/api/quote-accept-verbal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || 'Could not record the acceptance.'); return; }
      setMsg(d.message);
    } catch { setErr('Could not record the acceptance.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-3">
      <button type="button" disabled={disabled || busy} onClick={mark}
        className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-surface-muted border border-line text-ink disabled:opacity-50">
        {busy ? 'Recording…' : 'Mark accepted (customer confirmed by phone)'}
      </button>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      {msg && <p className="mt-2 text-sm text-ok">{msg}</p>}
    </div>
  );
}

function SendQuote({ jobCardId, disabled, beforeSend, revision, currency, locale }: { jobCardId: string; disabled: boolean; beforeSend?: () => Promise<unknown>; revision?: boolean; currency: string; locale: string }) {
  const [sending, setSending] = React.useState(false);
  const [panel, setPanel] = React.useState<any>(null);
  const [note, setNote] = React.useState('');
  const fmt = (p: number) => formatMoney(p, { currency, locale });

  /** Flush any pending estimate edit FIRST, then read the diff — the prefill must describe what is
   *  actually about to be frozen, not what was on screen when the page loaded. */
  async function openPanel() {
    setErr(null);
    await beforeSend?.().catch(() => {});
    try {
      const r = await fetch(`/api/quote-revision-prefill?jobCardId=${encodeURIComponent(jobCardId)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.revision) { await send(); return; } // no accepted version after all — send as normal
      setPanel(d);
      setNote(d.email ? String(d.prefill ?? '') : '');
    } catch { await send(); }
  }

  const [result, setResult] = React.useState<{ url: string; emailed: boolean; sentTo: string | null; version: number; expiresAt: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function send() {
    setSending(true); setErr(null); setCopied(false);
    try {
      // FLUSH, don't cancel: settle any pending estimate autosave BEFORE freezing, so the version
      // captures the latest edit and no trailing write lands behind the freeze. Belt to the server
      // material-guard's braces — a stale autosave that still fires is now immaterial and no-ops.
      await beforeSend?.().catch(() => {});
      const r = await fetch('/api/quote-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, note: panel?.email ? (note.trim() || null) : null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || 'Could not send the quote.'); return; }
      setResult({ url: d.url, emailed: !!d.emailed, sentTo: d.sentTo ?? null, version: d.version, expiresAt: d.expiresAt });
      setPanel(null); setNote('');
    } catch { setErr('Could not send the quote.'); }
    finally { setSending(false); } // never strand the busy flag
  }

  return (
    <div className="mt-4 pt-4 border-t border-line">
      <button type="button" disabled={disabled || sending} onClick={revision ? openPanel : send}
        className="text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
        {/* THE WORDING FOLLOWS THE STATE. Once a version has been accepted the customer has agreed
            to a different figure, and the point of this send is that it CHANGED — "your quote is
            ready" would bury exactly the fact they need. A revision REVIEWS before it sends. */}
        {sending ? 'Sending…' : revision ? 'Send the updated price' : 'Send quote to customer'}
      </button>

      {/* ── REVIEW BEFORE SENDING A REVISION ────────────────────────────────────────────────────
          Both totals, the difference, and an editable note. OPTIONAL ALWAYS — clearing it and
          sending behaves exactly as a send does today. */}
      {panel && (
        <div className="mt-3 rounded-lg border border-warn bg-warn-soft/40 p-3" data-testid="revision-panel">
          <p className="text-sm font-semibold text-ink">
            Agreed {fmt(panel.agreedPennies)} (v{panel.agreedVersion}) → sending {fmt(panel.sendingPennies)}
            {' — '}{panel.differencePennies >= 0 ? '+' : '−'}{fmt(Math.abs(panel.differencePennies))}
          </p>
          {panel.email ? (
            <>
              <label className="block text-xs font-semibold text-ink mt-2">
                Add a note (optional) — sent with the email and shown on their quote page
              </label>
              <textarea data-testid="revision-note" rows={4} maxLength={1000} value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full mt-1 p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
              {/* The operator must know WHY they got the short version — not conclude there was
                  nothing to say. */}
              {!panel.diffComplete && (
                <p className="text-[11px] text-warn mt-1" data-testid="revision-diff-incomplete">
                  {panel.diffReason === 'duplicate_descriptions'
                    ? 'Two lines share a description, so the individual changes could not be listed automatically.'
                    : 'The approved version has no saved lines, so the individual changes could not be listed automatically.'}
                </p>
              )}
            </>
          ) : (
            // The note is email-only. Do not show a box that will not be delivered.
            <p className="text-xs text-muted mt-2" data-testid="revision-no-email">
              No email address on file — you'll get a link to pass on. A note can only be sent by email.
            </p>
          )}
          <div className="flex gap-2 mt-3">
            <button type="button" data-testid="revision-send" disabled={sending} onClick={send}
              className="text-sm font-semibold rounded-lg px-4 py-2 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button type="button" onClick={() => setPanel(null)} className="text-sm text-muted px-3 py-2">Cancel</button>
          </div>
        </div>
      )}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      {result && (
        <div className="mt-3 rounded-lg border border-line bg-surface-muted p-3">
          <p className="text-sm text-ink">
            {result.emailed
              ? <>{revision ? 'Updated price' : 'Quote'} v{result.version} emailed to <span className="font-medium">{result.sentTo}</span>.</>
              // BOTH branches follow the state. The no-email branch is the one the gate hit, and it
              // still said "Quote … is ready" for a revision — the exact wording this slice exists
              // to stop, surviving in the path a customer with no address on file takes.
              : <>{revision ? 'Updated price' : 'Quote'} v{result.version} is ready. {result.sentTo
                  ? <span className="text-warn">The email didn’t send — pass the link on instead.</span>
                  : <>No email address on file — pass this link on instead.</>}</>}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()}
              className="flex-1 p-2 text-xs bg-surface border border-line rounded-lg text-ink" />
            <button type="button"
              onClick={() => { navigator.clipboard?.writeText(result.url).then(() => setCopied(true)).catch(() => {}); }}
              className="shrink-0 text-xs font-medium bg-surface border border-line rounded-lg px-3 py-2 text-ink hover:bg-surface-muted">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Valid until {new Date(result.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
            Anyone with the link can view the quote. Editing the estimate cancels it and needs a new send.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- Completion mileage-out (advisories grain seed) ----------
function MileageOut(props: { jobCardId: string; initial: number | null; canEdit: boolean; busy: string | null; setBusy: (s: string | null) => void; setErr: (s: string | null) => void; onDone: () => void; t: (k: string, o?: any) => string; mileageIn: number | null; locale: string }) {
  const { t } = props;
  // Unset mileage-out DEFAULTS to mileage-in (keeps the car's mileage timeline gapless for the
  // future service-interval grain) but stays fully editable — road tests differ. Saved on the
  // button as before; the default is a starting value, never a lock.
  const [val, setVal] = useState(props.initial != null ? String(props.initial) : (props.mileageIn != null ? String(props.mileageIn) : ''));
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
