/**
 * File: lib/tenant-vat.ts
 * THE one place "does VAT apply for this tenant?" and "what is the true (reclaimable-adjusted)
 * cost?" are defined. The master switch (Group.vat_registered) gates VAT across quotes, invoices
 * and overheads — never checked inline. Read this, then feed the flag into computeQuoteTotals
 * (the math gate) and into the overhead true-cost formula. Gating happens at compute/display time;
 * stored per-line VAT flags are never rewritten, so re-registering restores VAT cleanly.
 */
import { prisma } from '@/lib/db';

export type TenantVat = { registered: boolean; number: string | null };

/** Single read of the tenant VAT state. Defaults to registered (VAT-as-now) if the row is missing. */
export async function getTenantVat(groupId: string | null | undefined): Promise<TenantVat> {
  if (!groupId) return { registered: true, number: null };
  const g = (await prisma.group.findUnique({
    where: { id: groupId },
    select: { vat_registered: true, vat_number: true },
  })) as { vat_registered: boolean; vat_number: string | null } | null;
  return { registered: g ? !!g.vat_registered : true, number: g?.vat_number ?? null };
}

/** Does VAT apply anywhere for this tenant? The single predicate every surface consults. */
export function isVatApplicable(vat: { registered: boolean } | null | undefined): boolean {
  return !!vat?.registered;
}

/**
 * True cost of an overhead for P&L. A VAT-registered business reclaims input VAT, so the true
 * cost is ex-VAT (gross − reclaimable VAT); a non-registered business bears the full gross.
 */
export function overheadTrueCostPennies(
  overhead: { amountPennies: number; vatAmountPennies: number },
  registered: boolean,
): number {
  const gross = Math.max(0, Math.round(overhead.amountPennies || 0));
  const vat = Math.max(0, Math.round(overhead.vatAmountPennies || 0));
  return registered ? Math.max(0, gross - vat) : gross;
}
