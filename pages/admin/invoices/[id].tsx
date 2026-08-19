/**
 * File: pages/admin/invoices/[id].tsx
 * The GreaseDesk invoice — the primary VAT document the customer receives. ONE-OBJECT model: while
 * `issued` this renders the job card's LIVE lines (extra authorised work updates the bill under the
 * same number — edits happen on the card's Quote tab, there is no separate invoice-line editor);
 * once `paid` it renders the frozen snapshot. Warranty (comeback) invoices show a single
 * "no charge" £0 line. Data comes from lib/invoice-doc (shared with the PDF + email, so the three
 * can never disagree). unit_cost is INTERNAL and rendered NOWHERE here. Paid unlock is ADMIN-only
 * and audited. i18n-native, formatMoney, mobile-first.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { useTranslation } from 'next-i18next';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { buildInvoiceDoc } from '@/lib/invoice-doc';
import { prisma } from '@/lib/db';
// SERVER-SIDE ONLY — reaches node:crypto through lib/magic-link. Next tree-shakes it out of the
// client bundle because it is used solely inside getServerSideProps; do not read it in the component.
import { offersPayLink } from '@/lib/invoice-pay-link';
// THE SAME rule object the endpoint uses. Pure (no prisma), so the screen offers the control on
// exactly the invoices the server would accept — never a button that 409s, never a hidden one that
// would have worked.
import { canVoid, VOID_CATEGORIES, MIN_REASON_LENGTH, validateVoidReason } from '@/lib/invoice-void';
import { withI18n } from '@/lib/gssp-i18n';
import { formatMoney } from '@/lib/format-money';
import { showVatTotalLine } from '@/lib/invoice';
import { quoteRefund, refundConfirmationLines } from '@/lib/refund-quote';
import { refundLines } from '@/lib/invoice-refund-state';
import { RefundPanel } from '@/components/refund/RefundPanel';

type Line = { description: string; qty: number; unitPricePennies: number; vatRate: number; netPennies: number };
type Totals = { breakdown: Array<{ rate: number; netPennies: number; vatPennies: number }>; netPennies: number; vatPennies: number; grossPennies: number };
type PageProps = {
  displayNumber: string;
  secondaryNumber: string | null;
  isImported: boolean;
  invoiceId: string;
  number: string;
  status: 'issued' | 'paid_pending' | 'paid' | 'settled' | 'void';
  voidedAt: string | null;
  voidReason: string | null;
  voidCorrections: Array<{ at: string; by: string | null; from: string; to: string }>;
  hasFrozenLines: boolean; // freeze-at-issue: no lines = admin-unlocked, under correction
  /** Is there anything to pay? Server-computed via lib/invoice-pay-link::offersPayLink. */
  offersPayLink: boolean;
  /** The settled card payment a refund would act on, if there is one. */
  refundable: {
    paymentId: string; amountPennies: number; alreadyRefundedPennies: number;
    applicationFeePennies: number | null; stripeFeePennies: number | null;
    applicationFeeReturnedPennies: number;
  } | null;
  /** The customer holds a copy. Only decides whether to show the GENERIC warning — the server's
   *  own, figure-bearing confirmation is what actually gates an amendment. */
  wasSent: boolean;
  /** Amendment history, so the document page says what the customer's copy will say. */
  amendedAt: string | null;
  amendedFromPennies: number | null;
  amendmentCount: number;
  series: 'chargeable' | 'warranty' | 'historical';
  confirmDueAt: string | null;   // pending: when the clearance window elapses
  paymentMethod: string | null;
  manualPending: boolean;
  taxLabel: string;
  footerText: string | null;
  datePaid: string | null;       // yyyy-mm-dd (document fact, manager-editable)
  dateIssued: string;            // yyyy-mm-dd (document fact, manager-editable; effective value)
  /** A receipt send was ATTEMPTED AND FAILED. Not 'no receipt yet' — see the loader. */
  receiptFailed: boolean;
  /** Money that came and went. doc.refund, serialised — NOT re-derived here. */
  refund: { kind: 'none' | 'partial' | 'full'; refundedPennies: number; receivedPennies?: number; at: string | null };
  issuedAt: string;
  vatRegistered: boolean;
  company: { name: string; vatNumber: string | null; address: string | null };
  customer: { name: string; address: string | null };
  vehicle: { reg: string | null; desc: string | null; vin: string | null; mileage: number | null };
  /** The frozen due-items block, as printed at mint (lib/due-items::printedDueItemsBlock). */
  dueItemsBlock: string | null;
  lines: Line[];
  totals: Totals;
  currency: string;
  locale: string;
  canEdit: boolean;   // issued + manager → edits happen on the card's Quote tab
  canManage: boolean; // manager/admin — unmark-pending visibility (server re-checks)
  isAdmin: boolean;   // paid unlock visibility (server re-checks)
  jobCardId: string;
};

export default function InvoicePage(props: PageProps) {
  const { t } = useTranslation('invoice');
  const router = useRouter();
  const fmt = (p: number) => formatMoney(p, { currency: props.currency, locale: props.locale });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Void: a two-stage panel. `form` collects, `confirm` shows what will be RETAINED before anything
  // is written — a void is not undoable through the UI, so the last screen states the consequence.
  const [voidStage, setVoidStage] = useState<null | 'form' | 'confirm'>(null);
  const [voidCategory, setVoidCategory] = useState<string>('');
  const [voidReason, setVoidReason] = useState('');
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendText, setAmendText] = useState('');
  const reg = props.vatRegistered;
  // A warranty document shows NO VAT anywhere (not a supply for consideration — the lines render
  // at net retail and the goodwill line zeroes the total before VAT would arise). Also gates the
  // totals block to the loud AMOUNT DUE £0.00.
  const showVat = reg && props.series !== 'warranty';
  const refundText = props.refund.kind === 'none' ? null : refundLines(
    { kind: props.refund.kind, refundedPennies: props.refund.refundedPennies, receivedPennies: props.refund.receivedPennies ?? 0, at: props.refund.at ? new Date(props.refund.at) : null } as any,
    { money: fmt, locale: props.locale },
  );

  async function emailInvoice() {
    setBusy('email'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: props.invoiceId }) });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? { text: t('emailSent'), ok: true } : { text: data?.message || t('emailError'), ok: false });
    } catch { setMsg({ text: t('emailError'), ok: false }); }
    setBusy(null);
  }

  // ── REFUND ───────────────────────────────────────────────────────────────────────────────
  // Two stages on purpose. The first collects an amount; the second states what it COSTS before
  // anything is sent, because the surprise in a card refund is not the amount going back — it is
  // Stripe's processing fee, which does not. A garage owner should meet that here rather than on a
  // statement three days later.
  const [refundStage, setRefundStage] = useState<null | 'form' | 'confirm'>(null);
  const [refundInput, setRefundInput] = useState('');
  const r = props.refundable;
  const remainingRefundable = r ? r.amountPennies - r.alreadyRefundedPennies : 0;
  const refundPennies = Math.round(parseFloat(refundInput || '0') * 100);
  const quote = r && refundPennies > 0
    ? quoteRefund({
        amountPennies: r.amountPennies, refundPennies, alreadyRefundedPennies: r.alreadyRefundedPennies,
        applicationFeePennies: r.applicationFeePennies, stripeFeePennies: r.stripeFeePennies,
        applicationFeeAlreadyReturnedPennies: r.applicationFeeReturnedPennies,
      })
    : null;

  async function sendRefund() {
    if (!r || !quote?.ok) return;
    setBusy('refund'); setMsg(null);
    try {
      const res = await fetch('/api/payments/refund', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: r.paymentId, amountPennies: quote.quote.refundPennies }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg({ text: data?.message || (res.ok ? 'Refund sent.' : 'The refund couldn’t be sent.'), ok: res.ok });
      if (res.ok) {
        setRefundStage(null); setRefundInput('');
        // The webhook writes the ledger, not us — so re-read after a moment rather than claiming
        // the refund is done. If it has not landed yet the page simply shows the same thing again.
        setTimeout(() => router.replace(router.asPath), 2500);
      }
    } catch { setMsg({ text: 'The refund couldn’t be sent.', ok: false }); }
    setBusy(null);
  }

  /** Text the customer a link to PAY. A different artefact from the email, which sends the document. */
  async function textPayLink() {
    setBusy('sms'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: props.invoiceId }) });
      const data = await res.json().catch(() => ({}));
      // The remaining allowance, not a per-message price — the figure a garage can act on.
      const left = typeof data?.allowance?.remaining === 'number'
        ? ` ${data.allowance.remaining} text${data.allowance.remaining === 1 ? '' : 's'} left this month.` : '';
      setMsg(res.ok
        ? { text: `Pay link texted to the customer.${left}`, ok: true }
        : { text: `${data?.message || 'The text couldn’t be sent.'}${left}`, ok: false });
    } catch { setMsg({ text: 'The text couldn’t be sent.', ok: false }); }
    setBusy(null);
  }

  /**
   * ── THE SERVER DECIDES WHAT NEEDS CONFIRMING; THIS ONLY ASKS ────────────────────────────────
   * Post without `confirm`. If the invoice has left the building — sent, or sent and paid — the
   * endpoint answers 409 `confirm_required` with a sentence naming the figures, and we put that
   * sentence in front of the human verbatim and post again with their answer.
   *
   * Deliberately NOT a client-side "is it paid?" check that decides whether to ask. The client
   * would then be the thing that knows the rule, and a screen that forgot to ask would amend a paid
   * invoice silently. The server refuses an unconfirmed amendment on its own account; this is the
   * dialog, not the gate.
   */
  async function postUnlock(action: 'unlock' | 'reissue', errKey: string): Promise<boolean> {
    const call = (confirm?: boolean) => fetch('/api/invoice-unlock', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: props.invoiceId, action, ...(confirm ? { confirm: true } : {}) }),
    });
    let res = await call();
    let data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.code === 'confirm_required') {
      if (!window.confirm(`${data.message}\n\nContinue?`)) return false;
      res = await call(true);
      data = await res.json().catch(() => ({}));
    }
    if (!res.ok) { setMsg({ text: data?.message || t(errKey), ok: false }); return false; }
    return true;
  }

  async function reissue() {
    setBusy('reissue'); setMsg(null);
    try {
      if (await postUnlock('reissue', 'reissueError')) await router.replace(router.asPath);
    } catch { setMsg({ text: t('reissueError'), ok: false }); }
    finally { setBusy(null); }
  }
  async function doAmend() {
    setBusy('amend'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-void-amend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: props.invoiceId, reason: amendText }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('void.amendError'), ok: false }); setBusy(null); return; }
      setAmendOpen(false); setAmendText('');
      router.replace(router.asPath);
    } catch { setMsg({ text: t('void.amendError'), ok: false }); setBusy(null); }
  }

  async function doVoid() {
    setBusy('void'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-void', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: props.invoiceId, category: voidCategory, reason: voidReason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('void.error'), ok: false }); setBusy(null); return; }
      setVoidStage(null);
      router.replace(router.asPath); // status change — reload the document
    } catch { setMsg({ text: t('void.error'), ok: false }); setBusy(null); }
  }

  async function unlock() {
    // The generic warning only for an invoice nobody has seen. Where the customer holds a copy, or
    // has paid, the SERVER's sentence is the one that names the figures — asking twice would train
    // people to click through both.
    if (props.status !== 'paid' && !props.wasSent && !window.confirm(t('unlockConfirm'))) return;
    setBusy('unlock'); setMsg(null);
    try {
      if (await postUnlock('unlock', 'unlockError')) router.replace(router.asPath);
    } catch { setMsg({ text: t('unlockError'), ok: false }); }
    finally { setBusy(null); }
  }

  // Manual/early confirmation — "the money actually arrived" (manager/admin, audited, receipt sends).
  async function confirmReceived() {
    if (!window.confirm(t('pending.confirmReceivedConfirm'))) return;
    setBusy('confirm'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-confirm-paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: props.invoiceId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('pending.confirmError'), ok: false }); setBusy(null); return; }
      router.replace(router.asPath);
    } catch { setMsg({ text: t('pending.confirmError'), ok: false }); setBusy(null); }
  }

  // Silent unmark during the clearance window (paid_pending only) — nothing was sent, no confirm
  // dialog theatrics needed beyond a plain confirm; distinct from the ADMIN unlock above.
  async function unmarkPaid() {
    if (!window.confirm(t('pending.unmarkConfirm'))) return;
    setBusy('unmark'); setMsg(null);
    try {
      const res = await fetch('/api/invoice-unmark-paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: props.invoiceId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('pending.unmarkError'), ok: false }); setBusy(null); return; }
      router.replace(router.asPath); // pending → issued — reload the live document
    } catch { setMsg({ text: t('pending.unmarkError'), ok: false }); setBusy(null); }
  }

  return (
    <>
      <Head><title>{t('title')} {props.displayNumber || props.number} - GreaseDesk</title></Head>
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <Link href={`/admin/jobcards/${props.jobCardId}`} className="text-sm text-accent hover:underline">← {t('back')}</Link>
          <div className="flex flex-wrap items-center gap-2">
            {props.canEdit && (
              <Link href={`/admin/jobcards/${props.jobCardId}?tab=quote`} className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-4 py-2 hover:bg-surface">{t('editOnCard')}</Link>
            )}
            <a href={`/api/invoice-pdf?id=${props.invoiceId}`} className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-4 py-2 hover:bg-surface">{t('downloadPdf')}</a>
            {/* Not on a void. The server refuses it (409, step 1) and re-sending a retired
                document is exactly what must not happen — a button that always fails is a trap,
                not a safeguard. The PDF link above STAYS: the retained document must remain
                producible (VATREC5010). */}
            {props.status !== 'void' && props.series !== 'historical' && (
              <button onClick={emailInvoice} disabled={busy !== null} data-testid="invoice-email" className="text-sm bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 disabled:opacity-50">
                {busy === 'email' ? t('emailSending') : t('emailSend')}
              </button>
            )}
            {/* ONLY WHERE THERE IS SOMETHING TO PAY. offersPayLink already excludes a void, a
                warranty, an unlocked document and a £0 total, so this needs no second copy of
                those conditions — unlike the email button above, which sends the document and is
                still meaningful on a settled invoice. */}
            {props.offersPayLink && (
              <button onClick={textPayLink} disabled={busy !== null} data-testid="invoice-text-pay" className="text-sm bg-surface-muted border border-line text-ink rounded-lg px-4 py-2 hover:bg-surface disabled:opacity-50">
                {busy === 'sms' ? 'Texting…' : 'Text pay link'}
              </button>
            )}
            {props.status === 'paid_pending' && props.canManage && (
              <button onClick={unmarkPaid} disabled={busy !== null} className="text-sm text-warn border border-line rounded-lg px-4 py-2 hover:bg-warn-soft disabled:opacity-50">
                {busy === 'unmark' ? t('pending.unmarking') : t('pending.unmark')}
              </button>
            )}
            {(props.status === 'paid' || props.status === 'settled' || (props.status === 'issued' && props.hasFrozenLines)) && props.isAdmin && (
              <button onClick={unlock} disabled={busy !== null} className="text-sm text-danger border border-danger/40 rounded-lg px-4 py-2 hover:bg-danger-soft disabled:opacity-50">
                {busy === 'unlock' ? t('unlocking') : t('unlock')}
              </button>
            )}
            {props.isAdmin && props.status !== 'void' && (() => {
              // ONE RULE, SHARED. `canVoid` is the endpoint's own precondition, imported.
              const check = canVoid({ status: props.status, lineCount: props.lines.length });
              // WHERE IT WOULD BE REFUSED, SAY SO. A vanished button teaches nothing; the reason
              // an unlocked invoice cannot be voided is the instruction for how to void it.
              if (!check.ok) return (
                <span className="text-xs text-muted self-center max-w-md" data-testid="void-blocked">{check.message}</span>
              );
              return (
                <button onClick={() => { setVoidStage('form'); setMsg(null); }} disabled={busy !== null}
                  data-testid="void-open"
                  className="text-sm text-danger border border-danger/40 rounded-lg px-4 py-2 hover:bg-danger-soft disabled:opacity-50">
                  {t('void.open')}
                </button>
              );
            })()}
            {props.status === 'issued' && !props.hasFrozenLines && props.isAdmin && (
              <button onClick={reissue} disabled={busy !== null} className="text-sm text-ok border border-ok/40 rounded-lg px-4 py-2 hover:bg-ok-soft disabled:opacity-50">
                {busy === 'reissue' ? t('reissuing') : t('reissue')}
              </button>
            )}
          </div>
        </div>

        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}
        {/* RETIRED, AND SAID SO. The document is retained and still renders (VATREC5010), so the
            screen must carry the fact and the reason — otherwise the retained copy is
            indistinguishable from a live demand for payment. */}
        {/* ── VOID PANEL ────────────────────────────────────────────────────────────────────────
            Two stages on purpose. Stage 1 collects; stage 2 states what SURVIVES, because the
            thing people get wrong about voiding is assuming it deletes. It does the opposite —
            the document and its number are kept, which is what makes the gap explainable. */}
        {voidStage && props.isAdmin && (() => {
          const checked = validateVoidReason(voidReason);
          const ready = !!voidCategory && checked.ok;
          const RECON = t('void.reconstructionNote');
          return (
            <div className="border border-danger/40 rounded-xl p-4 mb-4 bg-danger-soft/30" data-testid="void-panel">
              <h3 className="text-sm font-semibold text-danger mb-2">{t('void.title')}</h3>

              {voidStage === 'form' ? (
                <>
                  <label className="block text-xs font-semibold text-ink mb-1">{t('void.categoryLabel')}</label>
                  <select data-testid="void-category" value={voidCategory} onChange={(e) => setVoidCategory(e.target.value)}
                    className="w-full sm:max-w-xs p-2 bg-surface border border-line rounded-lg text-ink text-sm mb-3">
                    <option value="">{t('void.categoryPick')}</option>
                    {VOID_CATEGORIES.map((c) => <option key={c} value={c}>{t(`void.category.${c}`)}</option>)}
                  </select>

                  <label className="block text-xs font-semibold text-ink mb-1">{t('void.reasonLabel')}</label>
                  <textarea data-testid="void-reason" value={voidReason} rows={3} maxLength={500}
                    onChange={(e) => setVoidReason(e.target.value)} placeholder={t('void.reasonPlaceholder')}
                    className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
                  {/* One click to record that the retained lines are a rebuild — the case where the
                      original snapshot was destroyed by an unlock before the void. */}
                  {!voidReason.includes(RECON) && (
                    <button type="button" data-testid="void-add-reconstruction"
                      onClick={() => setVoidReason((r) => (r.trim() ? r.trim() + ' ' : '') + RECON)}
                      className="text-xs text-accent hover:underline mt-1">+ {t('void.addReconstruction')}</button>
                  )}
                  {/* Mirrors the server's rule so the refusal arrives while typing, not on submit.
                      The server stays authoritative — this is feedback, not the gate. */}
                  <p className={`text-xs mt-1 ${checked.ok ? 'text-muted' : 'text-warn'}`} data-testid="void-reason-hint">
                    {checked.ok ? t('void.reasonOk', { n: voidReason.trim().length }) : (checked as any).error}
                  </p>

                  <div className="flex gap-2 mt-3">
                    <button data-testid="void-review" disabled={!ready} onClick={() => setVoidStage('confirm')}
                      className="text-sm font-semibold rounded-lg px-4 py-2 bg-danger-soft text-danger border border-danger/40 disabled:opacity-40">
                      {t('void.review')}
                    </button>
                    <button onClick={() => setVoidStage(null)} className="text-sm text-muted px-3 py-2">{t('void.cancel')}</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-ink mb-2">{t('void.confirmIntro')}</p>
                  <ul className="text-sm text-ink space-y-1 mb-3" data-testid="void-retained">
                    <li>• {t('void.keepNumber', { number: props.number })}</li>
                    <li>• {t('void.keepTotal', { total: fmt(props.totals.grossPennies) })}</li>
                    <li>• {t('void.keepLines', { count: props.lines.length })}</li>
                    <li>• <strong>{t('void.keepConsumed', { number: props.number })}</strong></li>
                  </ul>
                  <p className="text-xs text-muted mb-1">{t('void.confirmReasonLabel')}</p>
                  <p className="text-sm text-ink border border-line rounded-lg p-2 mb-3 bg-surface" data-testid="void-confirm-reason">
                    {t(`void.category.${voidCategory}`)} — {voidReason.trim()}
                  </p>
                  <div className="flex gap-2">
                    <button data-testid="void-commit" disabled={busy !== null} onClick={doVoid}
                      className="text-sm font-semibold rounded-lg px-4 py-2 bg-danger text-white disabled:opacity-50">
                      {busy === 'void' ? t('void.working') : t('void.commit')}
                    </button>
                    <button onClick={() => setVoidStage('form')} className="text-sm text-muted px-3 py-2">{t('void.back')}</button>
                  </div>
                </>
              )}
            </div>
          );
        })()}

        {/* AMENDED: the same sentence the customer's PDF carries, so the garage can see exactly
            what their copy says before anyone rings up about it. */}
        {props.amendedAt && (
          <div className="bg-warn-soft text-warn rounded-lg p-3 text-sm mb-3" data-testid="detail-amended-notice">
            {t('amendedNotice', {
              when: new Date(props.amendedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
              from: props.amendedFromPennies == null ? '—' : fmt(props.amendedFromPennies),
            })}
            {props.amendmentCount > 1 && <span className="block mt-1 text-xs">{t('amendedCount', { n: props.amendmentCount })}</span>}
          </div>
        )}
        {props.status === 'void' && (
          <div className="bg-danger-soft text-danger rounded-lg p-3 text-sm mb-3" data-testid="detail-void-notice">
            {t('voidNotice', { when: props.voidedAt ?? '—', reason: props.voidReason || t('voidNoReason') })}
            {/* BOTH TEXTS, ALWAYS. An amended reason must never read as the only wording ever
                recorded — the original is the first correction's `from` and stays on the page. */}
            {props.voidCorrections.length > 0 && (
              <div className="mt-2 pt-2 border-t border-danger/30 text-xs" data-testid="void-history">
                <p className="font-semibold">{t('void.historyTitle')}</p>
                <p data-testid="void-history-original">
                  <span className="opacity-70">{t('void.historyOriginal')}: </span>
                  <span className="line-through">{props.voidCorrections[0].from}</span>
                </p>
                {props.voidCorrections.map((c, i) => (
                  <p key={i} data-testid="void-history-entry">
                    <span className="opacity-70">{t('void.historyEntry', { when: new Date(c.at).toLocaleDateString(props.locale) })}: </span>
                    {c.to}
                  </p>
                ))}
              </div>
            )}
            {props.isAdmin && !amendOpen && (
              <button data-testid="void-amend-open" onClick={() => { setAmendText(props.voidReason ?? ''); setAmendOpen(true); setMsg(null); }}
                className="mt-2 text-xs underline hover:no-underline">{t('void.amendOpen')}</button>
            )}
            {props.isAdmin && amendOpen && (() => {
              const checked = validateVoidReason(amendText);
              const changed = amendText.trim() !== (props.voidReason ?? '').trim();
              return (
                <div className="mt-3 pt-3 border-t border-danger/30" data-testid="void-amend-panel">
                  <p className="text-xs font-semibold">{t('void.amendTitle')}</p>
                  <p className="text-xs opacity-80 mb-2">{t('void.amendIntro')}</p>
                  <textarea data-testid="void-amend-text" rows={3} maxLength={500} value={amendText}
                    onChange={(e) => setAmendText(e.target.value)}
                    className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
                  <p className={`text-xs mt-1 ${checked.ok ? 'opacity-70' : 'text-warn'}`} data-testid="void-amend-hint">
                    {checked.ok ? t('void.reasonOk', { n: amendText.trim().length }) : (checked as any).error}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button data-testid="void-amend-save" disabled={!checked.ok || !changed || busy !== null} onClick={doAmend}
                      className="text-sm font-semibold rounded-lg px-3 py-1.5 bg-danger text-white disabled:opacity-40">
                      {busy === 'amend' ? t('void.amendWorking') : t('void.amendSave')}
                    </button>
                    <button onClick={() => setAmendOpen(false)} className="text-sm opacity-70 px-2">{t('void.cancel')}</button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        {/* Freeze-at-issue: frozen lines are the document; an unlocked invoice is under correction. */}
        {props.status === 'issued' && props.hasFrozenLines && <p className="text-xs text-muted mb-3">{t('frozenNote')}</p>}
        {props.status === 'issued' && !props.hasFrozenLines && (
          <div className="bg-warn-soft text-warn rounded-lg p-3 text-sm mb-3">{t('unlockedNote')}</div>
        )}
        {props.status === 'paid_pending' && (
          <div className="bg-warn-soft text-warn rounded-lg p-3 text-sm mb-3">
            {props.manualPending
              ? t('pending.manualNote', { method: props.paymentMethod ?? '—' })
              : t('pending.note', { when: props.confirmDueAt ?? '—' })}
            {props.canManage && (
              <button onClick={confirmReceived} disabled={busy !== null}
                className="block mt-2 text-sm font-semibold rounded-lg px-3 py-1.5 bg-ok-soft text-ok border border-line disabled:opacity-50">
                {busy === 'confirm' ? t('pending.confirming') : t('pending.confirmReceived')}
              </button>
            )}
          </div>
        )}
        {/* ── REFUND ──────────────────────────────────────────────────────────────────────────
            Offered only where there is a settled card payment with something left on it — decided
            server-side (props.refundable), never guessed here. PARTIAL FROM THE START: a customer
            disputing one line of four is the ordinary workshop case, and full-only would send the
            garage back to the Stripe dashboard for exactly the scenario we most want on this path. */}
        {/* ── REFUND ──────────────────────────────────────────────────────────────────────────
            THE SAME COMPONENT the job card's Refund tab renders. Extracted rather than left inline
            when the tab was built: the sentences that say Stripe's fee is not coming back are the
            most carefully worded thing on the money path, and a second copy would be a second set
            of words to keep in step — the failure the shared refundLines copy exists to prevent,
            one screen earlier. Eligibility is still decided server-side (props.refundable). */}
        {props.refundable && props.status !== 'void' && (
          <div className="mb-3">
            <RefundPanel
              payments={[{
                paymentId: props.refundable.paymentId,
                origin: 'card',
                receivedPennies: props.refundable.amountPennies,
                alreadyRefundedPennies: props.refundable.alreadyRefundedPennies,
                remainingPennies: Math.max(0, props.refundable.amountPennies - props.refundable.alreadyRefundedPennies),
                currency: props.currency,
                collectedAt: new Date(),
                methodLabel: null,
                refusal: null,
                applicationFeePennies: props.refundable.applicationFeePennies,
                stripeFeePennies: props.refundable.stripeFeePennies,
                applicationFeeAlreadyReturnedPennies: props.refundable.applicationFeeReturnedPennies,
              }]}
              methods={[]}
              canManage={props.canManage}
              invoiceRefusal={null}
              money={fmt}
              today={new Date().toISOString().slice(0, 10)}
              onDone={() => setTimeout(() => router.replace(router.asPath), 1500)}
            />
          </div>
        )}

        {/* ── MONEY THAT CAME AND WENT ────────────────────────────────────────────────────────
            The SAME sentences the customer's link shows, from lib/invoice-refund-state::refundLines.
            Verbatim, not a paraphrase: when a customer rings quoting their screen, the person
            answering should be reading the same words back. */}
        {refundText && (
          <div className="rounded-lg p-3 text-sm mb-3 bg-surface-muted border border-line" data-testid="admin-refund-state">
            <p className="font-semibold text-ink" data-testid="refund-headline">{refundText.headline}</p>
            <p className="text-muted mt-0.5" data-testid="refund-detail">{refundText.detail}</p>
          </div>
        )}

        {props.receiptFailed && (
          <div className="bg-warn-soft text-warn rounded-lg p-3 text-sm mb-3" data-testid="receipt-failed">{t('pending.receiptNotSent')}</div>
        )}
        {/* A voided invoice's dates are historical fact — the endpoint refuses the edit, so the
            editor would only ever produce a 409. */}
        {/* A historical record's printed date is a fact about someone else's document. */}
        {props.canManage && props.status !== 'void' && props.series !== 'historical' && (
          <DateIssuedEditor invoiceId={props.invoiceId} initial={props.dateIssued} t={t} onSaved={() => router.replace(router.asPath)} />
        )}
        {(props.status === 'paid' || props.status === 'paid_pending') && props.canManage && (
          <DatePaidEditor invoiceId={props.invoiceId} initial={props.datePaid} t={t} onSaved={() => router.replace(router.asPath)} />
        )}
        {props.status === 'paid' && <p className="text-xs text-muted mb-3">{t('paidLocked')}</p>}

        {/* The document */}
        <div className="bg-surface border border-line rounded-xl p-5 sm:p-8">
          {/* Header */}
          <div className="flex flex-wrap justify-between gap-4 pb-5 border-b border-line">
            <div className="min-w-0">
              <div className="text-lg font-bold text-ink">{props.company.name}</div>
              {props.company.address && <div className="text-sm text-muted whitespace-pre-line">{props.company.address}</div>}
              {reg && props.company.vatNumber && (
                <div className="text-xs text-muted mt-1">{t('vatNumber', { label: props.taxLabel })} {props.company.vatNumber}</div>
              )}
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-ink tracking-wide">{t('title').toUpperCase()}</div>
              <div className="text-sm text-ink font-mono mt-1">{props.displayNumber || props.number}</div>
              {props.secondaryNumber && (
                <div className="text-xs text-muted font-mono">GreaseDesk {props.secondaryNumber}</div>
              )}
              <div className="text-xs text-muted">{t('issued')}: {props.issuedAt}</div>
              <div className="flex justify-end gap-1 mt-2">
                {props.series === 'warranty' && (
                  <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-warn-soft text-warn">{t('warrantyBadge')}</span>
                )}
                {/* SAME FIX AS THE LIST. This ternary used to END in `issuedBadge`, so a status it
                    had never heard of wore the ISSUED face — a voided invoice announced itself as
                    live. `issued` is now NAMED; anything unrecognised prints as itself. */}
                <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                  // REFUNDED BEATS PAID on the face of it. Driven by refund.kind, never by status —
                  // status stays `paid` deliberately, and adding a `refunded` status to make this
                  // easier is exactly the second opinion the derived state exists to avoid.
                  props.refund.kind === 'full' ? 'bg-surface-muted text-ink border border-line'
                  : props.refund.kind === 'partial' ? 'bg-warn-soft text-warn'
                  : props.status === 'paid' ? 'bg-ok-soft text-ok'
                  : props.status === 'void' ? 'bg-danger-soft text-danger'
                  : props.status === 'paid_pending' || props.status === 'issued' ? 'bg-warn-soft text-warn'
                  : 'bg-surface-muted text-muted border border-line border-dashed'}`} data-testid="detail-status-badge">
                  {props.refund.kind === 'full' ? 'Refunded'
                    : props.refund.kind === 'partial' ? 'Part refunded'
                    : props.status === 'paid' ? t('paidBadge')
                    : props.status === 'paid_pending' ? t('pendingBadge')
                    : props.status === 'void' ? t('voidBadge')
                    : props.status === 'issued' ? t('issuedBadge')
                    : props.status}
                </span>
              </div>
            </div>
          </div>

          {/* Bill-to + vehicle */}
          <div className="flex flex-wrap justify-between gap-4 py-5 border-b border-line">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted mb-1">{t('billTo')}</div>
              <div className="text-sm text-ink font-medium">{props.customer.name}</div>
              {props.customer.address && <div className="text-sm text-muted whitespace-pre-line">{props.customer.address}</div>}
            </div>
            {(props.vehicle.reg || props.vehicle.desc || props.vehicle.vin || props.vehicle.mileage != null) && (
              <div className="text-right">
                <div className="text-xs uppercase tracking-wide text-muted mb-1">{t('vehicle')}</div>
                {props.vehicle.reg && <div className="text-sm text-ink font-medium">{t('vehicleBlock.registration')}: {props.vehicle.reg}</div>}
                {props.vehicle.desc && <div className="text-sm text-muted">{props.vehicle.desc}</div>}
                {props.vehicle.vin && <div className="text-sm text-muted">{t('vehicleBlock.vin')}: {props.vehicle.vin}</div>}
                {props.vehicle.mileage != null && <div className="text-sm text-muted">{t('vehicleBlock.mileage')}: {props.vehicle.mileage.toLocaleString(props.locale)}</div>}
              </div>
            )}
          </div>

          {/* Lines */}
          <div className="py-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-xs uppercase tracking-wide border-b border-line">
                  <th className="text-left font-medium py-2">{t('cols.description')}</th>
                  <th className="text-right font-medium py-2 px-2">{t('cols.qty')}</th>
                  <th className="text-right font-medium py-2 px-2">{t('cols.unitPrice')}</th>
                  {showVat && <th className="text-right font-medium py-2 px-2">{t('cols.vatRate', { label: props.taxLabel })}</th>}
                  <th className="text-right font-medium py-2">{showVat ? t('cols.net') : t('cols.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {props.lines.map((l, i) => (
                  <tr key={i} className="border-b border-line/60">
                    <td className="py-2 text-ink whitespace-pre-line">{l.description}</td>
                    <td className="py-2 px-2 text-right text-ink tabular-nums">{l.qty}</td>
                    <td className="py-2 px-2 text-right text-ink tabular-nums">{fmt(l.unitPricePennies)}</td>
                    {showVat && <td className="py-2 px-2 text-right text-muted tabular-nums">{l.vatRate}%</td>}
                    <td className="py-2 text-right text-ink tabular-nums">{fmt(l.netPennies)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="pt-4 border-t border-line flex justify-end">
            <div className="w-full sm:w-72 text-sm space-y-1">
              {props.series === 'warranty' ? (
                /* The LOUDEST figure on the document — a customer must never think they owe the
                   goods value shown above. No VAT lines at all on a warranty document. */
                <div className="flex justify-between items-baseline text-2xl font-extrabold border-t-2 border-ink pt-2">
                  <span className="text-ink uppercase tracking-wide">{t('amountDue')}</span>
                  <span className="text-ink tabular-nums">{fmt(0)}</span>
                </div>
              ) : reg ? (
                <>
                  <div className="flex justify-between"><span className="text-muted">{t('subtotal', { label: props.taxLabel })}</span><span className="text-ink tabular-nums">{fmt(props.totals.netPennies)}</span></div>
                  {props.totals.breakdown.map((b) => (
                    <div key={b.rate} data-testid="vat-rate-line" className="flex justify-between"><span className="text-muted">{t('vatAt', { rate: b.rate, label: props.taxLabel })}</span><span className="text-ink tabular-nums">{fmt(b.vatPennies)}</span></div>
                  ))}
                  {showVatTotalLine(props.totals) && (
                    <div data-testid="vat-total-line" className="flex justify-between"><span className="text-muted">{t('totalVat', { label: props.taxLabel })}</span><span className="text-ink tabular-nums">{fmt(props.totals.vatPennies)}</span></div>
                  )}
                  <div className="flex justify-between text-base font-semibold border-t border-line pt-1"><span className="text-ink">{t('grandTotal')}</span><span className="text-ink tabular-nums">{fmt(props.totals.grossPennies)}</span></div>
                </>
              ) : (
                <div className="flex justify-between text-base font-semibold"><span className="text-ink">{t('total')}</span><span className="text-ink tabular-nums">{fmt(props.totals.netPennies)}</span></div>
              )}
              {props.series !== 'warranty' && (props.status === 'paid' || props.status === 'paid_pending') && (
                <>
                  <div className="flex justify-between"><span className="text-muted">{t('lessAmountPaid', { label: props.taxLabel })}{props.datePaid ? ` (${props.datePaid})` : ''}</span><span className="text-ink tabular-nums">-{fmt(reg ? props.totals.grossPennies : props.totals.netPennies)}</span></div>
                  <div className="flex justify-between text-base font-semibold border-t border-line pt-1"><span className="text-ink">{t('amountDue')}</span><span className="text-ink tabular-nums">{fmt(0)}</span></div>
                </>
              )}
            </div>
          </div>
          {/* ADVISORY, BELOW THE TOTAL — matching the PDF. Nothing above the total but what is
              being charged for; advice adjacent to priced rows can read as one of them. Moving it
              is a LAYOUT change: freeze-at-issue governs CONTENT, and the frozen
              due_items_snapshot is untouched. See lib/invoice-pdf for the full reasoning. */}
          {props.dueItemsBlock && (
            <div className="mt-6 border-t border-line pt-4" data-testid="invoice-due-items">
              <p className="text-xs uppercase tracking-wide text-muted mb-1">{t('advisory.heading')}</p>
              <p className="text-sm text-muted whitespace-pre-line">{props.dueItemsBlock}</p>
            </div>
          )}

          {props.footerText && <p className="text-xs text-muted mt-6 whitespace-pre-line border-t border-line pt-4">{props.footerText}</p>}

          {!reg && props.series !== 'warranty' && <p className="text-xs text-muted mt-4">{t('notRegistered', { label: props.taxLabel })}</p>}
        </div>
      </div>
    </>
  );
}

// Date-issued: the DOCUMENT issue/billing date — defaults from mint, manager/admin-editable,
// audited + guarded server-side (not future, not before the job). The P&L recognises by this date.
function DateIssuedEditor({ invoiceId, initial, t, onSaved }: { invoiceId: string; initial: string; t: (k: string, o?: any) => string; onSaved: () => void | Promise<unknown> }) {
  const [val, setVal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/invoice-date-issued', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId, dateIssued: val }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || t('dateIssued.error')); setBusy(false); return; }
      await Promise.resolve(onSaved()); // wait for the in-place refresh — the component does NOT remount
    } catch { setErr(t('dateIssued.error')); }
    setBusy(false); // always return to idle (the refreshed `initial` disables Save until edited again)
  }
  return (
    <div className="flex flex-wrap items-end gap-2 mb-3">
      <label className="block">
        <span className="block text-xs text-muted mb-1">{t('dateIssued.label')}</span>
        <input type="date" value={val} onChange={(e) => setVal(e.target.value)} className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
      </label>
      <button onClick={save} disabled={busy || !val || val === initial} className="text-sm rounded-lg px-3 py-2 bg-surface-muted border border-line text-ink disabled:opacity-50">
        {busy ? t('dateIssued.saving') : t('dateIssued.save')}
      </button>
      {err && <span className="text-sm text-danger">{err}</span>}
    </div>
  );
}

// Date-paid: the DOCUMENT fact — defaults from mark-paid, manager/admin-editable, audited server-side.
function DatePaidEditor({ invoiceId, initial, t, onSaved }: { invoiceId: string; initial: string | null; t: (k: string, o?: any) => string; onSaved: () => void | Promise<unknown> }) {
  const [val, setVal] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/invoice-date-paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId, datePaid: val }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || t('datePaid.error')); setBusy(false); return; }
      await Promise.resolve(onSaved()); // wait for the in-place refresh — the component does NOT remount
    } catch { setErr(t('datePaid.error')); }
    setBusy(false); // always return to idle (the refreshed `initial` disables Save until edited again)
  }
  return (
    <div className="flex flex-wrap items-end gap-2 mb-3">
      <label className="block">
        <span className="block text-xs text-muted mb-1">{t('datePaid.label')}</span>
        <input type="date" value={val} onChange={(e) => setVal(e.target.value)} className="p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
      </label>
      <button onClick={save} disabled={busy || !val || val === initial} className="text-sm rounded-lg px-3 py-2 bg-surface-muted border border-line text-ink disabled:opacity-50">
        {busy ? t('datePaid.saving') : t('datePaid.save')}
      </button>
      {err && <span className="text-sm text-danger">{err}</span>}
    </div>
  );
}

export const getServerSideProps = withI18n(['invoice'])(async (ctx: any) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };

  const doc = await buildInvoiceDoc(String(ctx.params?.id || ''), user.group_id);
  if (!doc) return { redirect: { destination: '/admin/dashboard', permanent: false } };

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, doc.siteId)) return { redirect: { destination: '/admin/dashboard', permanent: false } };

  return {
    props: {
      invoiceId: doc.invoiceId,
      number: doc.number,
      displayNumber: (doc as any).displayNumber ?? doc.number,
      secondaryNumber: (doc as any).secondaryNumber ?? null,
      isImported: (doc as any).isImported ?? false,
      status: doc.status,
      series: doc.series,
      hasFrozenLines: doc.lines.length > 0, // freeze-at-issue: empty = admin-unlocked, under correction
      // IS THERE ANYTHING TO PAY? The same predicate /api/invoice-sms refuses with, so the Text
      // button is never offered where the send could only 409. Computed HERE rather than in the
      // component because lib/invoice-pay-link reaches lib/magic-link and therefore node:crypto —
      // the mistake that once shipped a blank customer page.
      offersPayLink: offersPayLink(doc),
      // Straight off the doc the loader already built. The customer's link reads the same field
      // through the same function; the garage must not learn about a refund later than they do.
      refund: { ...doc.refund, at: doc.refund.at ? doc.refund.at.toISOString() : null },
      // THE PAYMENT A REFUND WOULD ACT ON. Only a settled Stripe one: a manual cash payment is not
      // ours to reverse, and a `processing` intent has not cleared. Absent means no button — the
      // same discipline as offersPayLink, decided server-side rather than guessed in the page.
      refundable: await (async () => {
        const p = (await prisma.payment.findFirst({
          where: { invoice_id: doc.invoiceId, provider: 'stripe', status: 'succeeded' },
          orderBy: { collected_at: 'desc' },
          select: {
            id: true, amount_pennies: true, application_fee_pennies: true, stripe_fee_pennies: true,
            refunds: { select: { amount_pennies: true, application_fee_refunded_pennies: true } },
          },
        })) as any;
        if (!p) return null;
        const alreadyRefundedPennies = p.refunds.reduce((a: number, r: any) => a + (r.amount_pennies ?? 0), 0);
        if (alreadyRefundedPennies >= p.amount_pennies) return null; // nothing left to give back
        return {
          paymentId: p.id, amountPennies: p.amount_pennies, alreadyRefundedPennies,
          applicationFeePennies: p.application_fee_pennies, stripeFeePennies: p.stripe_fee_pennies,
          applicationFeeReturnedPennies: p.refunds.reduce((a: number, r: any) => a + (r.application_fee_refunded_pennies ?? 0), 0),
        };
      })(),
      wasSent: !!doc.receiptSentAt,
      amendedAt: (doc as any).amendedAt ?? null,
      amendedFromPennies: (doc as any).amendedFromPennies ?? null,
      amendmentCount: (doc as any).amendmentCount ?? 0,
      confirmDueAt: doc.confirmDueAt ? doc.confirmDueAt.toLocaleString(doc.locale, { timeZone: 'UTC' }) : null,
      paymentMethod: doc.paymentMethod,
      manualPending: doc.manualPending,
      taxLabel: doc.taxLabel,
      footerText: doc.footerText,
      datePaid: doc.datePaid ? doc.datePaid.toISOString().slice(0, 10) : null,
      dateIssued: doc.issuedAt.toISOString().slice(0, 10), // effective document date (date_issued ?? issued_at)
      // ── EVIDENCE OF FAILURE, NOT ABSENCE OF SUCCESS ──────────────────────────────────────
      // This was `paid && !receipt_sent_at`, which conflated three different situations and fired
      // on 933 of the paid invoices — a receipt genuinely failing, a receipt not yet sent, and a
      // receipt that was never due at all (a counter-marked-paid job, a historical import). Only
      // the first deserves an alarm; the other two deserve silence, and telling 933 invoices their
      // receipt "could not be sent" taught everyone to ignore the one where it had.
      //
      // So the condition is inverted: alarm only where a send was ATTEMPTED AND FAILED, which
      // NotificationLog records as a fact. Absence now means absence.
      //
      // It also clears the window this would otherwise misreport: between fulfilment settling the
      // invoice and the receipt stamp landing there is no failed row, so nothing is claimed.
      receiptFailed: doc.status === 'paid' && (await prisma.notificationLog.count({
        where: { subject_type: 'invoice', subject_id: doc.invoiceId, template: 'invoice_document', status: 'failed' },
      })) > 0,
      voidedAt: doc.voidedAt ? doc.voidedAt.toLocaleDateString(doc.locale) : null,
      voidReason: doc.voidReason ?? null,
      voidCorrections: doc.voidCorrections,
      issuedAt: doc.issuedAt.toLocaleDateString(doc.locale),
      vatRegistered: doc.vatRegistered,
      company: doc.company,
      customer: doc.customer,
      vehicle: doc.vehicle,
      dueItemsBlock: doc.dueItemsBlock ?? null,
      lines: doc.lines.map(({ description, qty, unitPricePennies, vatRate, netPennies }) => ({ description, qty, unitPricePennies, vatRate, netPennies })),
      totals: doc.totals,
      currency: doc.currency,
      locale: doc.locale,
      canEdit: doc.status === 'issued' && doc.lines.length === 0, // only an UNLOCKED invoice edits on the card (freeze-at-issue)
      canManage: true, // gssp already required canManageSite to view; server re-checks on POST
      isAdmin: vis.isAdmin,
      jobCardId: doc.jobCardId,
    },
  };
});
