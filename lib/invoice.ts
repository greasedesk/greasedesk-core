/**
 * File: lib/invoice.ts
 * Invoice chokepoints (non-numbering): the freeze guard, the company-identity resolver, and the
 * money helpers. Reuses the pennies conversions from lib/quote-totals — money math is not
 * reimplemented. formatMoney (lib/format-money) renders; this only computes.
 */
import { poundsToPennies } from '@/lib/quote-totals';
import { taxOnBasePennies, aggregateFrozenTax } from '@/lib/tax';

/** Single freeze guard — FREEZE-AT-ISSUE (ruling 2026-07-12): the ledger locks when the lines
 *  freeze, which is at ISSUE, not at paid. The audited ADMIN unlock deletes the frozen lines;
 *  that absence IS the unlocked state (re-issue / re-pay re-snapshots and re-locks). settled
 *  (warranty terminal) and paid stay frozen behind the same unlock. */
export function canEditInvoice(invoice: { status: string; hasFrozenLines: boolean }): boolean {
  return invoice.status === 'issued' && !invoice.hasFrozenLines;
}

/**
 * THE SAME FACT, NAMED FROM THE CUSTOMER'S SIDE. An invoice whose lines have been dropped is
 * "editable" to the garage and "being updated" to the customer — one state, two questions:
 *   garage:   can I change this?            → canEditInvoice
 *   customer: why is this document blank?   → isUnderCorrection
 *
 * Deliberately an ALIAS and not a second predicate. This state is invisible in the data — an
 * unlocked invoice has status `issued` like any other, and only the ABSENCE of lines distinguishes
 * it — so a reader who does not know the trick writes `status === 'issued'` and renders a real
 * invoice number above an empty table with a £0.00 total. pages/api/invoice-unlock had the test
 * open-coded, which is one copy away from the two drifting; a customer-facing renderer would have
 * been the second. Two names over one function cannot disagree.
 */
export const isUnderCorrection = canEditInvoice;

// ---- Effective document dates (ONE truth for recognition + rendering) ----
// Each date exists twice: the editable DOCUMENT fact (date_issued / date_paid) and the system
// attestation (issued_at / paid_at). Every reader — P&L, tiles, AR list, invoice view, PDF —
// resolves through these, so the printed document and the accounts always agree.
export const effectiveIssueDate = (r: { date_issued: Date | null; issued_at: Date }): Date =>
  r.date_issued ?? r.issued_at;
export const effectivePaidDate = (r: { date_paid: Date | null; paid_at: Date | null }): Date | null =>
  r.date_paid ?? r.paid_at;

/** SQL-level bucket for "effective issue date in [from, to)" — the same fallback as
 *  effectiveIssueDate, expressed as a where fragment so tiles can filter in the query. */
export const effectiveIssueDateWhere = (from: Date, to: Date) => ({
  OR: [
    { date_issued: { gte: from, lt: to } },
    { date_issued: null, issued_at: { gte: from, lt: to } },
  ],
});

// ---- Date-edit guardrails (pure — matrix-tested; the APIs translate keys to friendly text) ----
// All comparisons are DATE-grained UTC: a document date has no meaningful time-of-day.
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
/** Issue date: not in the future, not before the job's booked date (when the card has one). */
export function validateIssueDate(d: Date, jobDate: Date | null, today: Date): 'future' | 'beforeJob' | null {
  if (utcDay(d) > utcDay(today)) return 'future';
  if (jobDate && utcDay(d) < utcDay(jobDate)) return 'beforeJob';
  return null;
}
/** Payment date: not in the future, not before the invoice's effective issue date. */
export function validatePaymentDate(d: Date, issueDate: Date, today: Date): 'future' | 'beforeIssue' | null {
  if (utcDay(d) > utcDay(today)) return 'future';
  if (utcDay(d) < utcDay(issueDate)) return 'beforeIssue';
  return null;
}

// ---- Company identity for the header (decision D: Site's own number/VAT wins WHEN SET, else Group) ----
export type CompanyIdentity = { name: string; companyNumber: string | null; vatNumber: string | null; address: string | null };

export function resolveCompanyIdentity(
  group: { group_name: string; company_number: string | null; vat_number: string | null; address: string | null },
  site: { company_number: string | null; vat_number: string | null; address: string | null } | null,
): CompanyIdentity {
  const pick = (s: string | null | undefined, g: string | null | undefined) => (s && s.trim() ? s : g ?? null) ?? null;
  return {
    name: group.group_name,
    companyNumber: pick(site?.company_number, group.company_number),
    vatNumber: pick(site?.vat_number, group.vat_number),
    address: pick(site?.address, group.address),
  };
}

// ---- Per-line money (pennies). Rate applied via the lib/tax chokepoint; VAT zeroed when not registered. ----
export function computeInvoiceLinePennies(qty: number, unitPricePennies: number, vatRate: number, vatApplies: boolean) {
  const q = Number.isFinite(qty) ? qty : 0;
  const price = Number.isFinite(unitPricePennies) ? unitPricePennies : 0;
  const net = Math.round(q * price);
  // rateBp = rate × 100 (rate is Decimal(5,2), never >2dp) → byte-identical to round(net × rate / 100).
  const vat = taxOnBasePennies({ taxModel: 'vat', isRegistered: vatApplies }, net, Math.round((Number.isFinite(vatRate) ? vatRate : 0) * 100));
  return { netPennies: net, vatPennies: vat };
}

// ---- VAT breakdown by rate + grand totals, from STORED (frozen) line values. This is the RENDER/AR
// path: it AGGREGATES the frozen per-line net + tax and re-derives nothing — an issued invoice's tax
// is immutable, so today's registration/rate must never touch it (see lib/tax rule 1). ----
export type InvoiceLineLike = { vat_rate: unknown; line_total: unknown; line_vat: unknown };
export type InvoiceTotals = {
  breakdown: Array<{ rate: number; netPennies: number; vatPennies: number }>;
  netPennies: number; vatPennies: number; grossPennies: number;
};

/**
 * SHOW THE "Total VAT" LINE ONLY WHEN IT SAYS SOMETHING THE RATE LINES DON'T.
 *
 * On a single-rate invoice the per-rate line and the total are the same number twice —
 * "VAT at 20% £16.67" then "Total VAT £16.67" — which reads as a fault in the document rather
 * than as arithmetic. With two or more rates the total is genuinely new information: a 20% labour
 * line beside a zero-rated MOT needs both the split (so the customer can see WHICH part was
 * zero-rated) and the sum.
 *
 * The per-rate lines always render. Dropping THEM instead and keeping the total would lose the
 * rate, which is the part a customer might need to reclaim against.
 *
 * One rule, three readers — the admin invoice page, the PDF and the customer-facing document each
 * render their own markup (React DOM, react-pdf primitives, and the shared DocumentLines
 * component), so this is the only thing they can share, and it is the thing that must not drift.
 */
export const showVatTotalLine = (totals: Pick<InvoiceTotals, 'breakdown'>): boolean =>
  totals.breakdown.length > 1;

export function invoiceTotals(lines: InvoiceLineLike[]): InvoiceTotals {
  const agg = aggregateFrozenTax(lines.map((l) => ({
    rateBp: Math.round(Number(l.vat_rate) * 100),
    netPennies: poundsToPennies(Number(l.line_total)),
    taxPennies: poundsToPennies(Number(l.line_vat)),
  })));
  // Re-expose in the historical shape (rate as percent, vatPennies) — callers are unchanged.
  return {
    breakdown: agg.breakdown.map((b) => ({ rate: b.rateBp / 100, netPennies: b.netPennies, vatPennies: b.taxPennies })),
    netPennies: agg.netPennies, vatPennies: agg.taxPennies, grossPennies: agg.grossPennies,
  };
}

/**
 * WHAT HAS ACTUALLY BEEN RECEIVED, as a number the product can subtract.
 *
 * ── WHY NULL BECOMES ZERO HERE, AND ONLY SINCE 2026-08-15 ───────────────────────────────────────
 * expectedCachePennies above still returns NULL for "no rows", and that is still the right thing
 * for the LEDGER to say. What changed is what the absence of rows MEANS. Before the backfill it
 * meant "possibly settled in cash years ago, we cannot know", and collapsing that to zero would
 * have shown a customer a demand for money they had already paid — which is exactly what the
 * customer view did for the few hours between the backfill finishing and this function existing.
 * The backfill wrote a row for every invoice the garage had marked paid, so that case is gone: no
 * rows now means nothing has been received, and the balance is the whole total.
 *
 * THIS IS SAFE ONLY BECAUSE THE INVARIANT HOLDS. scripts/payment-invariant-gate asserts —
 * unconditionally, now the ALLOW_PRE_BACKFILL hatch is removed — that no invoice carries a paid
 * figure without a ledger row behind it. If that check ever goes red, this function starts lying.
 * They are a pair: do not weaken the gate and leave this in place.
 *
 * The remaining edge is an old invoice the garage was paid for in cash and never marked paid. That
 * is not uncertainty on our side: the garage's own record says unpaid, and reporting what the
 * document says is correct behaviour rather than a guess.
 *
 * NOTE this answers "how much", not "was there a payment". lib/invoice-void's `wasPaid` asks the
 * second question and reads a NULL cache as evidence rather than as a quantity. Both are right;
 * they are not interchangeable.
 */
export const amountReceivedPennies = (inv: { amount_paid_pennies?: number | null }): number =>
  inv.amount_paid_pennies ?? 0;

/**
 * THE balance still owing — one derivation, shared by the customer view and (next slice) the
 * PaymentIntent. A negative result means the invoice is in credit; callers must handle that rather
 * than clamp it, because clamping hides an overpayment the garage needs to know about.
 */
export const balanceOwedPennies = (
  inv: { amount_paid_pennies?: number | null },
  totalPennies: number,
): number => totalPennies - amountReceivedPennies(inv);
