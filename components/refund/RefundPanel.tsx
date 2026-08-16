/**
 * File: components/refund/RefundPanel.tsx
 * THE refund control, for both origins, rendered wherever a refund can be recorded.
 *
 * Extracted from pages/admin/invoices/[id].tsx rather than copied into the job card. The dialog
 * that names Stripe's fee not coming back is the most carefully worded thing on the money path,
 * and a second copy of it would be a second set of words to keep in step — the same failure the
 * shared refundLines copy exists to prevent one screen further on.
 *
 * ── CARD AND MANUAL ARE DIFFERENT ACTS, NOT ONE ACT WITH A FLAG ─────────────────────────────────
 * A card refund ASKS Stripe and waits: success means Stripe accepted it, not that our rows have
 * caught up, and the panel says so in those terms. A manual refund RECORDS what already happened at
 * the counter: the money moved before anybody opened this screen. Two verbs, two confirmations, one
 * eligibility rule (lib/refund-eligibility) — so a control that appears is a control that works.
 */
import { useState } from 'react';
import { quoteRefund, refundConfirmationLines } from '@/lib/refund-quote';
import type { RefundableLine } from '@/lib/refund-eligibility';

export type RefundPanelPayment = RefundableLine & {
  /** Card-only, for the fee arithmetic. Absent on manual payments — there is no fee to reason about. */
  applicationFeePennies?: number | null;
  stripeFeePennies?: number | null;
  applicationFeeAlreadyReturnedPennies?: number;
};

export type RefundMethodOption = { id: string; name: string };

export function RefundPanel(props: {
  payments: RefundPanelPayment[];
  methods: RefundMethodOption[];
  canManage: boolean;
  /** Set when the INVOICE forbids refunds (void, or nothing invoiced). Explains, never hides. */
  invoiceRefusal: { code: string; message: string } | null;
  money: (pennies: number) => string;
  /** Today, as yyyy-mm-dd, from the server so the date does not depend on the till's clock. */
  today: string;
  onDone: () => void;
}) {
  const { payments, methods, canManage, invoiceRefusal, money, today } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const [stage, setStage] = useState<'form' | 'confirm'>('form');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [methodId, setMethodId] = useState(methods[0]?.id ?? '');
  const [when, setWhen] = useState(today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const open = payments.find((p) => p.paymentId === openId) ?? null;
  const pennies = Math.round(parseFloat(amount || '0') * 100);

  // Card arithmetic comes from the shared quote so the sentences below are the ones the endpoint
  // re-derives before it sends anything.
  const quote = open && open.origin === 'card' && pennies > 0
    ? quoteRefund({
        amountPennies: open.receivedPennies, refundPennies: pennies,
        alreadyRefundedPennies: open.alreadyRefundedPennies,
        applicationFeePennies: open.applicationFeePennies ?? null,
        stripeFeePennies: open.stripeFeePennies ?? null,
        applicationFeeAlreadyReturnedPennies: open.applicationFeeAlreadyReturnedPennies ?? 0,
      })
    : null;

  const manualInvalid = open && open.origin === 'manual'
    ? (!(pennies > 0) ? 'Enter how much you handed back.'
      : pennies > open.remainingPennies ? `That’s more than is left on this payment — at most ${money(open.remainingPennies)} can still be returned.`
        : !reason.trim() ? 'Say why this was refunded.'
          : !methodId ? 'Choose how the money went back.' : null)
    : null;

  function reset() { setOpenId(null); setStage('form'); setAmount(''); setReason(''); setWhen(today); }

  async function send() {
    if (!open) return;
    setBusy(true); setMsg(null);
    try {
      const isCard = open.origin === 'card';
      const res = await fetch(isCard ? '/api/payments/refund' : '/api/payments/manual-refund', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isCard
          ? { paymentId: open.paymentId, amountPennies: quote?.ok ? quote.quote.refundPennies : pennies }
          : { paymentId: open.paymentId, amountPennies: pennies, reason: reason.trim(), paymentMethodId: methodId, collectedAt: when }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg({ text: data?.message || (res.ok ? 'Done.' : 'That didn’t go through.'), ok: res.ok });
      if (res.ok) { reset(); props.onDone(); }
    } catch {
      setMsg({ text: 'That didn’t go through.', ok: false });
    } finally {
      // Cleared in a finally: a same-URL refresh never remounts this component, so a busy flag left
      // set by an early return would strand the button forever.
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <p className="text-sm text-muted" data-testid="refund-not-permitted">
        Recording a refund needs manager access for this location.
      </p>
    );
  }

  // AN HONEST EMPTY STATE, never a hidden tab. A garage looking for the refund control and not
  // finding it concludes the product cannot do it; a tab that says why is a smaller cost than that.
  if (invoiceRefusal) {
    return <p className="text-sm text-muted" data-testid="refund-empty">{invoiceRefusal.message}</p>;
  }
  if (!payments.length) {
    return (
      <p className="text-sm text-muted" data-testid="refund-empty">
        No money has been taken on this job yet, so there’s nothing to send back.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="refund-panel">
      {msg && (
        <div data-testid="refund-result" className={`rounded-lg p-2 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>
      )}

      {payments.map((p) => (
        <div key={p.paymentId} className="rounded-xl border border-line bg-surface p-4" data-testid={`refund-payment-${p.origin}`}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-ink">
              {money(p.receivedPennies)} {p.origin === 'card' ? 'by card online' : `by ${p.methodLabel ?? 'another method'}`}
              <span className="text-xs text-muted"> — {p.collectedAt instanceof Date ? p.collectedAt.toISOString().slice(0, 10) : String(p.collectedAt).slice(0, 10)}</span>
            </p>
            {p.alreadyRefundedPennies > 0 && (
              <span className="text-xs text-muted" data-testid="refund-already">{money(p.alreadyRefundedPennies)} already returned</span>
            )}
          </div>

          {/* A payment that cannot be refunded says WHY, in place. Dropping it from the list would
              leave a garage comparing a total against a shorter list and finding the gap itself. */}
          {p.refusal && <p className="mt-2 text-sm text-muted" data-testid="refund-line-refusal">{p.refusal.message}</p>}

          {!p.refusal && openId !== p.paymentId && (
            <button onClick={() => { setOpenId(p.paymentId); setStage('form'); setAmount((p.remainingPennies / 100).toFixed(2)); setMsg(null); }}
              disabled={busy} data-testid="refund-open"
              className="mt-3 text-sm rounded-lg px-4 py-2 border border-line text-ink hover:bg-surface-muted disabled:opacity-50">
              {p.origin === 'card' ? 'Refund to card…' : 'Record a refund…'}
            </button>
          )}

          {openId === p.paymentId && stage === 'form' && (
            <div className="mt-3" data-testid="refund-form">
              <p className="text-xs text-muted">
                {money(p.remainingPennies)} of {money(p.receivedPennies)} is still refundable.
              </p>
              <label className="block text-xs text-muted mt-3 mb-1">Amount</label>
              <input type="number" step="0.01" min="0.01" max={(p.remainingPennies / 100).toFixed(2)}
                value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="refund-amount"
                className="w-40 p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm" />

              {p.origin === 'manual' && (
                <>
                  <label className="block text-xs text-muted mt-3 mb-1">How it went back</label>
                  <select value={methodId} onChange={(e) => setMethodId(e.target.value)} data-testid="refund-method"
                    className="w-full sm:w-64 p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm">
                    {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  {/* Defaults to today, editable: handed back Friday, recorded Tuesday, moved Friday. */}
                  <label className="block text-xs text-muted mt-3 mb-1">Date the money went back</label>
                  <input type="date" value={when} onChange={(e) => setWhen(e.target.value)} data-testid="refund-date"
                    className="w-full sm:w-48 p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm" />
                  <label className="block text-xs text-muted mt-3 mb-1">Why</label>
                  <input type="text" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="refund-reason"
                    placeholder="e.g. goodwill on the brake job" className="w-full p-2 bg-surface border border-line rounded-lg text-ink text-base sm:text-sm" />
                </>
              )}

              {quote && !quote.ok && <p className="mt-2 text-sm text-danger" data-testid="refund-invalid">{quote.refusal.message}</p>}
              {manualInvalid && <p className="mt-2 text-sm text-danger" data-testid="refund-invalid">{manualInvalid}</p>}

              <div className="flex gap-2 mt-3">
                <button disabled={busy || (p.origin === 'card' ? !quote?.ok : !!manualInvalid)}
                  onClick={() => setStage('confirm')} data-testid="refund-review"
                  className="text-sm font-semibold rounded-lg px-4 py-2 bg-accent hover:bg-accent-hover text-white disabled:opacity-50">
                  Review
                </button>
                <button onClick={reset} className="text-sm text-muted px-3 py-2">Cancel</button>
              </div>
            </div>
          )}

          {openId === p.paymentId && stage === 'confirm' && (
            <div className="mt-3" data-testid="refund-confirm">
              {p.origin === 'card' && quote?.ok ? (
                <>
                  <p className="text-sm font-semibold text-ink">{quote.quote.isFull ? 'Refund in full?' : 'Refund part of this payment?'}</p>
                  {/* THE COST, IN THE GARAGE'S TERMS — sentences from lib/refund-quote, so the gate
                      asserts the words a garage owner actually reads. */}
                  <ul className="mt-2 space-y-1" data-testid="refund-cost-lines">
                    {refundConfirmationLines(quote.quote).map((line, i) => <li key={i} className="text-sm text-ink">• {line}</li>)}
                  </ul>
                  <p className="mt-2 text-[11px] text-muted">
                    We send this to Stripe; the invoice updates when Stripe confirms it, usually within a few seconds.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-ink">Record {money(pennies)} as refunded?</p>
                  {/* RECORDING, not sending. The money already moved; this says so and no more. */}
                  <ul className="mt-2 space-y-1" data-testid="refund-cost-lines">
                    <li className="text-sm text-ink">• {money(pennies)} goes back to the customer by {methods.find((m) => m.id === methodId)?.name ?? 'the chosen method'}.</li>
                    <li className="text-sm text-ink">• Dated {when} — the day the money moved, not the day it was typed in.</li>
                    <li className="text-sm text-ink">• Reason recorded: “{reason.trim()}”.</li>
                    <li className="text-sm text-ink">• This records a refund you have already made. It doesn’t move any money by itself.</li>
                  </ul>
                </>
              )}
              <div className="flex gap-2 mt-3">
                <button disabled={busy} onClick={send} data-testid="refund-send"
                  className="text-sm font-semibold rounded-lg px-4 py-2 bg-danger text-white hover:opacity-90 disabled:opacity-50">
                  {busy ? 'Working…' : p.origin === 'card' ? `Refund ${money(quote?.ok ? quote.quote.refundPennies : 0)}` : `Record ${money(pennies)}`}
                </button>
                <button onClick={() => setStage('form')} className="text-sm text-muted px-3 py-2">Back</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
