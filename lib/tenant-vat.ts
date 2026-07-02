/**
 * File: lib/tenant-vat.ts
 * THE one place "does VAT apply for this tenant?" and "what is the true (reclaimable-adjusted)
 * cost?" are defined. The master switch (Group.vat_registered) gates VAT across quotes, invoices
 * and overheads — never checked inline. Read this, then feed the flag into computeQuoteTotals
 * (the math gate) and into the overhead true-cost formula. Gating happens at compute/display time;
 * stored per-line VAT flags are never rewritten, so re-registering restores VAT cleanly.
 */
import { prisma } from '@/lib/db';

export type TenantVat = { registered: boolean; number: string | null; defaultRate: number };

const DEFAULT_RATE = 20;

/**
 * Single read of the tenant VAT state — registration + number + the company DEFAULT RATE. The rate
 * is THE one source that cascades as an editable pre-fill to quotes and overheads. Defaults to
 * registered / 20% if the row is missing.
 */
export async function getTenantVat(groupId: string | null | undefined): Promise<TenantVat> {
  if (!groupId) return { registered: true, number: null, defaultRate: DEFAULT_RATE };
  const g = (await prisma.group.findUnique({
    where: { id: groupId },
    select: { vat_registered: true, vat_number: true, default_vat_rate: true },
  })) as { vat_registered: boolean; vat_number: string | null; default_vat_rate: unknown } | null;
  return {
    registered: g ? !!g.vat_registered : true,
    number: g?.vat_number ?? null,
    defaultRate: g && g.default_vat_rate != null ? Number(g.default_vat_rate) : DEFAULT_RATE,
  };
}

/** Does VAT apply anywhere for this tenant? The single predicate every surface consults. */
export function isVatApplicable(vat: { registered: boolean } | null | undefined): boolean {
  return !!vat?.registered;
}

// ---- Overhead money model: ex-VAT amount + per-expense rate (gross + VAT are derived, not stored).

const clampRate = (r: number) => Math.min(100, Math.max(0, Number.isFinite(r) ? r : 0));

/** VAT component of an overhead: round(exVat × rate/100). */
export function overheadVatPennies(overhead: { exVatPennies: number; vatRate: number }): number {
  const exVat = Math.max(0, Math.round(overhead.exVatPennies || 0));
  return Math.round((exVat * clampRate(overhead.vatRate)) / 100);
}

/** Gross (what you're billed) = ex-VAT + VAT. */
export function overheadGrossPennies(overhead: { exVatPennies: number; vatRate: number }): number {
  return Math.max(0, Math.round(overhead.exVatPennies || 0)) + overheadVatPennies(overhead);
}

/**
 * True cost of an overhead for P&L. A VAT-registered business reclaims input VAT, so the true cost
 * is the ex-VAT amount (captured directly); a non-registered business bears the full gross.
 */
export function overheadTrueCostPennies(
  overhead: { exVatPennies: number; vatRate: number },
  registered: boolean,
): number {
  const exVat = Math.max(0, Math.round(overhead.exVatPennies || 0));
  return registered ? exVat : overheadGrossPennies(overhead);
}
