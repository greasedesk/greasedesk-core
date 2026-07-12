/**
 * File: lib/invoice-doc.ts
 * THE one resolver of an invoice's renderable document — shared by the invoice view (gssp), the
 * PDF, and the email, so the three can never disagree. FREEZE-AT-ISSUE (ruling 2026-07-12,
 * supersedes the "live while issued" one-object render): EVERY status renders the frozen
 * InvoiceLine snapshot — the lines lock at mint; post-issue growth requires the audited ADMIN
 * unlock → edit → re-issue. Warranty documents: real lines at NET retail + ONE goodwill line
 * zeroing the total; NO VAT anywhere on a warranty document — honouring a warranty is not a
 * supply for consideration (treatment per Hugh, accountant confirmation pending; never add a
 * VAT line without his say-so); AMOUNT DUE is always £0.00.
 * VAT is gated by vat_registered_at_issue at freeze; unit_cost is internal and never leaves
 * this module. Server-only.
 */
import { prisma } from '@/lib/db';
import { invoiceTotals, InvoiceTotals, effectiveIssueDate } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';
import { presignGet } from '@/lib/r2';

export type InvoiceDocLine = {
  description: string;
  qty: number;
  unitPricePennies: number;
  vatRate: number;
  netPennies: number;
  vatPennies: number;
};

export type InvoiceDoc = {
  invoiceId: string;
  jobCardId: string;
  siteId: string;
  number: string;
  status: 'issued' | 'paid_pending' | 'paid' | 'settled';
  confirmDueAt: Date | null;
  receiptSentAt: Date | null;
  datePaid: Date | null;        // the DOCUMENT fact (editable; defaults from mark-paid)
  paymentMethod: string | null; // how it was paid (snapshot name; internal grain)
  manualPending: boolean;       // pending with NO auto-confirm (manual method) — needs explicit confirmation
  taxLabel: string;             // admin-set (VAT/GST/Sales Tax…) — never derived from country
  footerText: string | null;    // payment terms / footer block (multi-line)
  logoUrl: string | null;       // presigned GET for the tenant logo (15-min; render-time use)
  logoFormat: 'png' | 'jpg' | null;
  series: 'chargeable' | 'warranty';
  issuedAt: Date;
  paidAt: Date | null;
  vatRegistered: boolean;
  company: { name: string; vatNumber: string | null; address: string | null };
  customer: { name: string; address: string | null };
  vehicle: { reg: string | null; desc: string | null; vin: string | null; mileage: number | null };
  lines: InvoiceDocLine[];
  totals: InvoiceTotals;
  currency: string;
  locale: string;
};

export async function buildInvoiceDoc(invoiceId: string, groupId: string): Promise<InvoiceDoc | null> {
  const inv = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: groupId },
    select: {
      id: true, site_id: true, status: true, series: true, invoice_number: true, issued_at: true, date_issued: true, paid_at: true, date_paid: true, confirm_due_at: true, receipt_sent_at: true, job_card_id: true,
      group: { select: { tax_label: true, invoice_footer_text: true, logo_r2_key: true } },
      company_name_snapshot: true, company_vat_number_snapshot: true, company_address_snapshot: true,
      customer_name_snapshot: true, customer_address_snapshot: true,
      vehicle_reg_snapshot: true, vehicle_desc_snapshot: true, vehicle_vin_snapshot: true, vehicle_mileage_snapshot: true, vat_registered_at_issue: true,
      payment_method_snapshot: true,
      lines: { orderBy: { position: 'asc' }, select: { description: true, qty: true, unit_price: true, vat_rate: true, line_vat: true, line_total: true } },
      site: { select: { currency_code: true, locale: true } },
      job_card: { select: { odometer_in: true, vehicle: { select: { registration: true, vin: true, mileage_at_create: true } } } },
    },
  })) as any;
  if (!inv) return null;

  const registered = !!inv.vat_registered_at_issue;
  const locale = inv.site?.locale ?? 'en-GB';
  // FREEZE-AT-ISSUE: every status renders the FROZEN snapshot — the lines lock at mint. An
  // UNLOCKED invoice (admin deleted the snapshot for correction) renders empty until re-issued/
  // re-paid; the card's estimate tab is where the correction happens.
  const lines: InvoiceDocLine[] = inv.lines.map((l: any) => ({
    description: l.description,
    qty: Number(l.qty),
    unitPricePennies: poundsToPennies(Number(l.unit_price)),
    vatRate: Number(l.vat_rate),
    netPennies: poundsToPennies(Number(l.line_total)),
    vatPennies: poundsToPennies(Number(l.line_vat)),
  }));

  const totals = invoiceTotals(lines.map((l) => ({ vat_rate: l.vatRate, line_total: l.netPennies / 100, line_vat: l.vatPennies / 100 })));

  return {
    invoiceId: inv.id,
    jobCardId: inv.job_card_id,
    siteId: inv.site_id,
    number: inv.invoice_number ?? '',
    status: inv.status,
    series: inv.series,
    // The PRINTED issue date = the effective DOCUMENT date (date_issued ?? issued_at) — the same
    // date the P&L recognises revenue by. One truth: the document and the accounts agree.
    issuedAt: new Date(effectiveIssueDate(inv)),
    paidAt: inv.paid_at ? new Date(inv.paid_at) : null,
    confirmDueAt: inv.confirm_due_at ? new Date(inv.confirm_due_at) : null,
    receiptSentAt: inv.receipt_sent_at ? new Date(inv.receipt_sent_at) : null,
    datePaid: inv.date_paid ? new Date(inv.date_paid) : (inv.paid_at ? new Date(inv.paid_at) : null),
    paymentMethod: inv.payment_method_snapshot ?? null,
    manualPending: inv.status === 'paid_pending' && !inv.confirm_due_at,
    taxLabel: inv.group?.tax_label || 'VAT',
    footerText: inv.group?.invoice_footer_text || null,
    logoUrl: inv.group?.logo_r2_key ? await presignGet(inv.group.logo_r2_key) : null,
    logoFormat: inv.group?.logo_r2_key ? (String(inv.group.logo_r2_key).endsWith('.png') ? 'png' : 'jpg') : null,
    vatRegistered: registered,
    company: { name: inv.company_name_snapshot, vatNumber: inv.company_vat_number_snapshot, address: inv.company_address_snapshot },
    customer: { name: inv.customer_name_snapshot, address: inv.customer_address_snapshot },
    // DELIBERATE ASYMMETRY (ruling 2026-07-12 — do NOT "tidy" this to match the line freeze):
    // MONEY freezes at ISSUE; vehicle IDENTITY FACTS (reg/VIN/mileage) stay LIVE-read from the
    // card while issued (a reg correction flows straight through to the unpaid document) and
    // freeze at PAID (re-snapshotted in the mark-paid tx). desc stays issue-snapshotted.
    vehicle: inv.status === 'issued'
      ? {
          reg: inv.job_card?.vehicle?.registration ?? inv.vehicle_reg_snapshot,
          desc: inv.vehicle_desc_snapshot,
          vin: inv.job_card?.vehicle?.vin ?? null,
          mileage: inv.job_card?.odometer_in ?? inv.job_card?.vehicle?.mileage_at_create ?? null,
        }
      : { reg: inv.vehicle_reg_snapshot, desc: inv.vehicle_desc_snapshot, vin: inv.vehicle_vin_snapshot, mileage: inv.vehicle_mileage_snapshot },
    lines,
    totals,
    currency: inv.site?.currency_code ?? 'GBP',
    locale,
  };
}
