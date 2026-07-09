/**
 * File: lib/invoice.ts
 * Invoice chokepoints (non-numbering): the freeze guard, the company-identity resolver, and the
 * money helpers. Reuses the pennies conversions from lib/quote-totals — money math is not
 * reimplemented. formatMoney (lib/format-money) renders; this only computes.
 */
import { poundsToPennies } from '@/lib/quote-totals';

/** Single freeze guard. Server-enforced on every invoice mutation — editable ONLY while issued.
 *  paid_pending freezes too (the snapshot is taken at mark-paid; the pending window is for
 *  unmarking, not editing); paid (confirmed) stays frozen behind the ADMIN unlock. */
export function canEditInvoice(invoice: { status: string }): boolean {
  return invoice.status === 'issued';
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
