/**
 * File: lib/invoice.ts
 * Invoice chokepoints (non-numbering): the freeze guard, the company-identity resolver, and the
 * money helpers. Reuses the pennies conversions from lib/quote-totals — money math is not
 * reimplemented. formatMoney (lib/format-money) renders; this only computes.
 */
import { poundsToPennies } from '@/lib/quote-totals';

/** Single freeze guard — FREEZE-AT-ISSUE (ruling 2026-07-12): the ledger locks when the lines
 *  freeze, which is at ISSUE, not at paid. The audited ADMIN unlock deletes the frozen lines;
 *  that absence IS the unlocked state (re-issue / re-pay re-snapshots and re-locks). settled
 *  (warranty terminal) and paid stay frozen behind the same unlock. */
export function canEditInvoice(invoice: { status: string; hasFrozenLines: boolean }): boolean {
  return invoice.status === 'issued' && !invoice.hasFrozenLines;
}

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

// ---- Per-line money (pennies). Mirrors quote-totals rounding; VAT zeroed when not registered. ----
export function computeInvoiceLinePennies(qty: number, unitPricePennies: number, vatRate: number, vatApplies: boolean) {
  const q = Number.isFinite(qty) ? qty : 0;
  const price = Number.isFinite(unitPricePennies) ? unitPricePennies : 0;
  const net = Math.round(q * price);
  const rate = vatApplies ? Math.min(100, Math.max(0, Number.isFinite(vatRate) ? vatRate : 0)) : 0;
  const vat = Math.round((net * rate) / 100);
  return { netPennies: net, vatPennies: vat };
}

// ---- VAT breakdown by rate + grand totals, from STORED line values (Decimal pounds → pennies). ----
export type InvoiceLineLike = { vat_rate: unknown; line_total: unknown; line_vat: unknown };
export type InvoiceTotals = {
  breakdown: Array<{ rate: number; netPennies: number; vatPennies: number }>;
  netPennies: number; vatPennies: number; grossPennies: number;
};

export function invoiceTotals(lines: InvoiceLineLike[]): InvoiceTotals {
  const byRate = new Map<string, { rate: number; netPennies: number; vatPennies: number }>();
  let netP = 0, vatP = 0;
  for (const l of lines) {
    const rate = Number(l.vat_rate);
    const net = poundsToPennies(Number(l.line_total));
    const vat = poundsToPennies(Number(l.line_vat));
    netP += net; vatP += vat;
    const key = rate.toFixed(2);
    const b = byRate.get(key) ?? { rate, netPennies: 0, vatPennies: 0 };
    b.netPennies += net; b.vatPennies += vat;
    byRate.set(key, b);
  }
  return {
    breakdown: Array.from(byRate.values()).sort((a, b) => b.rate - a.rate),
    netPennies: netP, vatPennies: vatP, grossPennies: netP + vatP,
  };
}
