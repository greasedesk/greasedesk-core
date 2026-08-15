/**
 * File: components/customer/CustomerInvoice.tsx
 * The customer's view of ONE frozen invoice, reached by an `invoice_pay` magic link.
 *
 * ── A THIRD CONSUMER, NOT A THIRD RENDERER ──────────────────────────────────────────────────────
 * Every figure comes from lib/invoice-doc (the same buildInvoiceDoc the admin view, the PDF and the
 * email use) and every line is drawn by components/DocumentLines (the same table the admin invoice
 * and the customer quote use). Nothing here computes money. A fourth renderer is how four surfaces
 * start disagreeing about VAT, so this file deliberately owns only layout and sentences.
 *
 * ── THE DOCUMENT STATE IS THE POINT ─────────────────────────────────────────────────────────────
 * A customer opens this link days or weeks after it was sent, from an email they may have skimmed,
 * and the invoice may have moved underneath them. Four states have to be said out loud, because in
 * every one of them the figures alone would mislead:
 *   VOID            — retired. The document is still shown, marked, with no demand attached: the
 *                     customer may be holding a PDF of it, and a retained copy must be
 *                     distinguishable from a live bill.
 *   UNDER CORRECTION— unlocked, lines dropped, status still `issued`. Without this branch the page
 *                     renders a real invoice number over an empty table and a £0.00 total.
 *   AMENDED         — the number survives a correction, so the customer can be holding two copies
 *                     that differ. The page says which one this is.
 *   PAID / PART-PAID— derived from the ledger through lib/payments::balanceOwedPennies, the same
 *                     derivation the payment path uses, so the figure a customer is shown and the
 *                     figure they would be charged cannot drift.
 *
 * NO PAYMENT HERE YET. Taking the money is the next slice; this renders the document and the state.
 * There is deliberately no "Pay now" button that does nothing.
 */
import React from 'react';
import Head from 'next/head';
import DocumentLines from '@/components/DocumentLines';
import { formatMoney } from '@/lib/format-money';
import { amountReceivedPennies, balanceOwedPennies } from '@/lib/invoice';
import type { InvoiceDoc } from '@/lib/invoice-doc';

/** Dates cross getServerSideProps as strings; the shape is otherwise the shared document. */
export type SerializedInvoiceDoc = Omit<InvoiceDoc, 'issuedAt' | 'paidAt' | 'voidedAt' | 'confirmDueAt' | 'receiptSentAt' | 'datePaid'> & {
  issuedAt: string;
  paidAt: string | null;
  voidedAt: string | null;
  datePaid: string | null;
};

const shellCls = 'min-h-screen bg-surface-muted py-6 px-4';
const cardCls = 'bg-surface border border-line rounded-2xl shadow-sm max-w-2xl mx-auto p-5 sm:p-8';

/**
 * Tone classes are WRITTEN OUT, never built from the prop. Tailwind resolves class names by scanning
 * source text, so `border-${tone}` compiles to nothing and the banner would ship unstyled — the
 * failure looks like a CSS bug and is actually a string one.
 */
const TONE = {
  warn: { edge: 'border-warn bg-warn-soft', label: 'text-warn' },
  danger: { edge: 'border-danger bg-danger-soft', label: 'text-danger' },
  ok: { edge: 'border-ok bg-ok-soft', label: 'text-ok' },
} as const;

const Banner = ({ tone, title, children, testId }: {
  tone: keyof typeof TONE; title: string; children: React.ReactNode; testId: string;
}) => (
  <div className={`mb-4 rounded-lg border-l-4 p-3 ${TONE[tone].edge}`} data-testid={testId}>
    <p className={`text-xs uppercase tracking-wide ${TONE[tone].label} mb-1`}>{title}</p>
    <div className="text-sm text-ink">{children}</div>
  </div>
);

export default function CustomerInvoice({ doc: d }: { doc: SerializedInvoiceDoc }) {
  const money = (p: number) => formatMoney(p, { currency: d.currency, locale: d.locale });
  const date = (iso: string) => new Date(iso).toLocaleDateString(d.locale, { day: 'numeric', month: 'long', year: 'numeric' });

  const totalPennies = d.vatRegistered ? d.totals.grossPennies : d.totals.netPennies;
  // ONE derivation, shared with the payment path — see lib/payments. A NULL cache reads as zero
  // received, which is only true because the backfill wrote a row for every invoice the garage had
  // marked paid; the invariant gate holds that line.
  const paid = amountReceivedPennies({ amount_paid_pennies: d.amountPaidPennies });
  const balance = balanceOwedPennies({ amount_paid_pennies: d.amountPaidPennies }, totalPennies);

  return (
    <>
      <Head>
        <title>Invoice {d.displayNumber} from {d.company.name} — GreaseDesk</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className={shellCls}>
        <div className={cardCls}>
          {/* The GARAGE's document. GreaseDesk is the carrier and says so nowhere on it. */}
          <div className="flex items-start justify-between gap-4 pb-5 border-b border-line">
            <div>
              {d.logoUrl
                ? <img src={d.logoUrl} alt={d.company.name} className="h-12 w-auto mb-2 object-contain" />
                : <h2 className="text-lg font-bold text-ink">{d.company.name}</h2>}
              {d.company.address && <p className="text-xs text-muted whitespace-pre-line mt-1">{d.company.address}</p>}
              {d.vatRegistered && d.company.vatNumber && (
                <p className="text-xs text-muted mt-1">{d.taxLabel} no. {d.company.vatNumber}</p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs uppercase tracking-wide text-muted">Invoice</p>
              <p className="text-sm font-semibold text-ink" data-testid="invoice-number">{d.displayNumber}</p>
              {/* An imported document keeps the number the customer already knows; ours is secondary. */}
              {d.secondaryNumber && <p className="text-[11px] text-muted">Ref {d.secondaryNumber}</p>}
              <p className="text-xs text-muted mt-1">{date(d.issuedAt)}</p>
            </div>
          </div>

          <div className="pt-5">
            {/* ── VOID. Shown, marked, with the garage's own reason — never hidden and never 404. ── */}
            {d.status === 'void' && (
              <Banner tone="danger" title="This invoice has been cancelled" testId="invoice-void">
                <p>
                  The garage cancelled this invoice{d.voidedAt ? ` on ${date(d.voidedAt)}` : ''}. There is nothing to pay.
                </p>
                {d.voidReason && <p className="mt-1 text-muted">Reason given: <span className="text-ink">{d.voidReason}</span></p>}
                {/* An amended reason must never look like the only thing ever written. */}
                {d.voidReasonOriginal && (
                  <p className="mt-1 text-xs text-muted">Originally recorded as: {d.voidReasonOriginal}</p>
                )}
              </Banner>
            )}

            {/* ── UNDER CORRECTION. The one state whose figures would otherwise be a plain lie. ── */}
            {d.underCorrection && d.status !== 'void' && (
              <Banner tone="warn" title="This invoice is being updated" testId="invoice-under-correction">
                <p>
                  The garage is making a change to this invoice, so the amounts aren’t final. They’ll send you
                  the updated version once it’s ready — there’s nothing you need to do.
                </p>
              </Banner>
            )}

            {/* ── AMENDED. The number survives a correction, so say which copy this is. ── */}
            {d.amendedAt && !d.underCorrection && d.status !== 'void' && (
              <Banner tone="warn" title="This invoice has been updated" testId="invoice-amended">
                <p>
                  This is the current version, updated on {date(d.amendedAt)}
                  {d.amendedFromPennies != null ? ` — it was previously ${money(d.amendedFromPennies)}` : ''}.
                  If you’re holding an earlier copy with the same number, this one replaces it.
                </p>
              </Banner>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-5 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted mb-1">Vehicle</p>
                <p className="text-ink font-semibold">{d.vehicle.reg ?? '—'}</p>
                {d.vehicle.desc && <p className="text-muted">{d.vehicle.desc}</p>}
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted mb-1">Billed to</p>
                <p className="text-ink">{d.customer.name || '—'}</p>
                {d.customer.address && <p className="text-muted whitespace-pre-line">{d.customer.address}</p>}
              </div>
            </div>

            {/* The lines are gone while unlocked, so an empty table would be the wrong thing to draw. */}
            {d.underCorrection ? (
              <p className="text-sm text-muted py-4 border-t border-line" data-testid="invoice-lines-withheld">
                The itemised breakdown will be here when the updated invoice is sent.
              </p>
            ) : (
              <DocumentLines
                lines={d.lines}
                totals={d.totals}
                showVat={d.vatRegistered}
                currency={d.currency}
                locale={d.locale}
                labels={{
                  description: 'Description', qty: 'Qty', unitPrice: 'Unit price',
                  vatRate: `${d.taxLabel} rate`, net: 'Net', amount: 'Amount',
                  subtotal: `Subtotal (excl. ${d.taxLabel})`,
                  vatAt: (rate) => `${d.taxLabel} at ${rate}%`,
                  totalVat: `Total ${d.taxLabel}`, grandTotal: 'Total', total: 'Total',
                }}
              />
            )}

            {!d.underCorrection && d.status !== 'void' && (
              <PaymentState
                status={d.status}
                paid={paid}
                balance={balance}
                totalPennies={totalPennies}
                datePaid={d.datePaid ?? d.paidAt}
                money={money}
                date={date}
              />
            )}

            {d.footerText && (
              <p className="mt-6 pt-5 border-t border-line text-xs text-muted whitespace-pre-line">{d.footerText}</p>
            )}

            <p className="mt-6 text-[11px] text-muted">
              Anyone with this link can view this invoice — please don’t forward it.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * What is owed.
 *
 * ── STATUS IS EVIDENCE WHERE THE LEDGER IS SILENT ───────────────────────────────────────────────
 * The FACT of payment comes from `status`, the AMOUNT from the ledger, and neither stands in for
 * the other. An invoice marked `paid` or `settled` is known to be paid even if the ledger has no
 * figure for it; checking the ledger first told a customer holding a receipted invoice to "contact
 * the garage about anything owing", which is worse than useless. ZZ's 0029 is that shape.
 *
 * ── THE UNKNOWN BRANCH IS GONE (2026-08-15) ─────────────────────────────────────────────────────
 * There used to be a third case: no ledger figure at all, rendered as "contact the garage". That
 * was right while the back catalogue had no rows — and became WRONG the moment the backfill
 * finished, because it then fired on every ordinary unpaid invoice, which is precisely what a pay
 * link is for. A NULL cache now reads as zero received; see lib/payments::amountReceivedPennies for
 * why that is safe and what holds it up.
 */
function PaymentState({ status, paid, balance, totalPennies, datePaid, money, date }: {
  status: string; paid: number; balance: number; totalPennies: number; datePaid: string | null;
  money: (p: number) => string; date: (iso: string) => string;
}) {
  // Settled by the document's own status, whatever the ledger does or doesn't know.
  if (status === 'paid' || status === 'settled') {
    return (
      <div className="mt-6 pt-5 border-t border-line" data-testid="invoice-paid">
        <p className="text-sm font-semibold text-ok">
          Paid in full{datePaid ? ` on ${date(datePaid)}` : ''} — thank you.
        </p>
      </div>
    );
  }
  if (status === 'paid_pending') {
    return (
      <div className="mt-6 pt-5 border-t border-line" data-testid="invoice-pending">
        <p className="text-sm text-muted">
          A payment has been recorded against this invoice and is being confirmed. There’s nothing you need to do.
        </p>
      </div>
    );
  }
  if (balance <= 0) {
    return (
      <div className="mt-6 pt-5 border-t border-line" data-testid="invoice-paid">
        <p className="text-sm font-semibold text-ok">
          Paid in full{datePaid ? ` on ${date(datePaid)}` : ''} — thank you.
        </p>
        {balance < 0 && (
          <p className="text-sm text-muted mt-1">
            You’ve paid {money(-balance)} more than the invoice total. Please contact the garage.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="mt-6 pt-5 border-t border-line" data-testid="invoice-due">
      {/* Part payments are named. A customer who paid a deposit must not be shown the full total
          as though nothing had arrived. */}
      {paid > 0 && (
        <p className="text-sm text-muted">
          Received so far: <span className="text-ink">{money(paid)}</span> of {money(totalPennies)}
        </p>
      )}
      <p className="text-base font-bold text-ink mt-1">
        Amount due: <span data-testid="invoice-amount-due">{money(balance)}</span>
      </p>
    </div>
  );
}
