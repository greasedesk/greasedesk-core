/**
 * File: lib/invoice-doc.ts
 * THE one resolver of an invoice's renderable document — shared by the invoice view (gssp), the
 * PDF, and the email, so the three can never disagree. One-object model:
 *   issued + chargeable → the card's LIVE items (a job that grows updates the bill, same number)
 *   issued + warranty   → a single "no charge" £0 line (ruling: never itemised)
 *   paid                → the frozen InvoiceLine snapshot (the income grain)
 * VAT is gated by vat_registered_at_issue in every branch; unit_cost is internal and never
 * leaves this module. Server-only.
 */
import { prisma } from '@/lib/db';
import { computeInvoiceLinePennies, invoiceTotals, InvoiceTotals } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';
import { tServer } from '@/lib/server-i18n';
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
  status: 'issued' | 'paid_pending' | 'paid';
  confirmDueAt: Date | null;
  receiptSentAt: Date | null;
  datePaid: Date | null;        // the DOCUMENT fact (editable; defaults from mark-paid)
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
      id: true, site_id: true, status: true, series: true, invoice_number: true, issued_at: true, paid_at: true, date_paid: true, confirm_due_at: true, receipt_sent_at: true, job_card_id: true,
      group: { select: { tax_label: true, invoice_footer_text: true, logo_r2_key: true } },
      company_name_snapshot: true, company_vat_number_snapshot: true, company_address_snapshot: true,
      customer_name_snapshot: true, customer_address_snapshot: true,
      vehicle_reg_snapshot: true, vehicle_desc_snapshot: true, vehicle_vin_snapshot: true, vehicle_mileage_snapshot: true, vat_registered_at_issue: true,
      lines: { orderBy: { position: 'asc' }, select: { description: true, qty: true, unit_price: true, vat_rate: true, line_vat: true, line_total: true } },
      site: { select: { currency_code: true, locale: true } },
    },
  })) as any;
  if (!inv) return null;

  const registered = !!inv.vat_registered_at_issue;
  const locale = inv.site?.locale ?? 'en-GB';
  let lines: InvoiceDocLine[];

  if (inv.status === 'paid' || inv.status === 'paid_pending') {
    // Frozen snapshot — render exactly what was locked at mark-paid (pending freezes too;
    // the window is for unmarking, never editing).
    lines = inv.lines.map((l: any) => ({
      description: l.description,
      qty: Number(l.qty),
      unitPricePennies: poundsToPennies(Number(l.unit_price)),
      vatRate: Number(l.vat_rate),
      netPennies: poundsToPennies(Number(l.line_total)),
      vatPennies: poundsToPennies(Number(l.line_vat)),
    }));
  } else if (inv.series === 'warranty') {
    lines = [{ description: tServer(locale, 'invoice', 'warrantyLine'), qty: 1, unitPricePennies: 0, vatRate: 0, netPennies: 0, vatPennies: 0 }];
  } else {
    // Live one-object render: the card's current items ARE the invoice while issued.
    const items = (await prisma.jobCardItem.findMany({
      where: { job_card_id: inv.job_card_id },
      select: { description: true, qty: true, unit_price: true, vat_rate: true },
      orderBy: { created_at: 'asc' },
    })) as any[];
    lines = items.map((it) => {
      const qty = Number(it.qty);
      const unitP = poundsToPennies(Number(it.unit_price));
      const rate = Number(it.vat_rate);
      const { netPennies, vatPennies } = computeInvoiceLinePennies(qty, unitP, rate, registered);
      return { description: it.description, qty, unitPricePennies: unitP, vatRate: registered ? rate : 0, netPennies, vatPennies };
    });
  }

  const totals = invoiceTotals(lines.map((l) => ({ vat_rate: l.vatRate, line_total: l.netPennies / 100, line_vat: l.vatPennies / 100 })));

  return {
    invoiceId: inv.id,
    jobCardId: inv.job_card_id,
    siteId: inv.site_id,
    number: inv.invoice_number ?? '',
    status: inv.status,
    series: inv.series,
    issuedAt: new Date(inv.issued_at),
    paidAt: inv.paid_at ? new Date(inv.paid_at) : null,
    confirmDueAt: inv.confirm_due_at ? new Date(inv.confirm_due_at) : null,
    receiptSentAt: inv.receipt_sent_at ? new Date(inv.receipt_sent_at) : null,
    datePaid: inv.date_paid ? new Date(inv.date_paid) : (inv.paid_at ? new Date(inv.paid_at) : null),
    taxLabel: inv.group?.tax_label || 'VAT',
    footerText: inv.group?.invoice_footer_text || null,
    logoUrl: inv.group?.logo_r2_key ? await presignGet(inv.group.logo_r2_key) : null,
    logoFormat: inv.group?.logo_r2_key ? (String(inv.group.logo_r2_key).endsWith('.png') ? 'png' : 'jpg') : null,
    vatRegistered: registered,
    company: { name: inv.company_name_snapshot, vatNumber: inv.company_vat_number_snapshot, address: inv.company_address_snapshot },
    customer: { name: inv.customer_name_snapshot, address: inv.customer_address_snapshot },
    vehicle: { reg: inv.vehicle_reg_snapshot, desc: inv.vehicle_desc_snapshot, vin: inv.vehicle_vin_snapshot, mileage: inv.vehicle_mileage_snapshot },
    lines,
    totals,
    currency: inv.site?.currency_code ?? 'GBP',
    locale,
  };
}
