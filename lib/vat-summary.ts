/**
 * File: lib/vat-summary.ts
 * THE output-VAT aggregation for the accountant's VAT-on-sales summary. OUTPUT VAT ONLY — it sums the
 * FROZEN per-line tax on issued CHARGEABLE invoices (never re-derives; same freeze-at-issue discipline
 * as aggregateFrozenTax), filtered by effectiveIssueDate. It deliberately does NOT touch input/purchase
 * VAT: parts unit_cost is an internal margin cost (not a VAT-coded purchase) and overheads are recurring
 * budget entries (not dated purchase invoices), so no defensible input-VAT figure exists — it is omitted,
 * and the report is labelled as VAT on sales only, not a complete return.
 */
import { prisma } from '@/lib/db';
import { effectiveIssueDateWhere } from '@/lib/invoice';

export type VatRateRow = { ratePercent: number; netPennies: number; vatPennies: number; lineCount: number };
export type VatSummary = {
  fromISO: string; toISO: string;
  invoiceCount: number;
  netPennies: number;   // total sales EX-VAT
  vatPennies: number;   // total OUTPUT VAT
  grossPennies: number; // net + vat
  byRate: VatRateRow[];  // breakdown by frozen VAT rate, highest rate first
};

const pennies = (d: unknown): number => Math.round(Number(d ?? 0) * 100);

/** Output VAT for [from, to) over the caller's visible sites. Chargeable + issued only; frozen tax. */
export async function getVatSummary(groupId: string, siteIds: string[], from: Date, to: Date): Promise<VatSummary> {
  const invoices = (await prisma.invoice.findMany({
    where: {
      group_id: groupId,
      site_id: { in: siteIds },
      series: 'chargeable',                                  // warranty (£0 goodwill) is not a sale
      status: { in: ['issued', 'paid_pending', 'paid'] },    // has a number; 'settled' = warranty terminal
      ...effectiveIssueDateWhere(from, to),
    },
    select: { id: true, lines: { select: { vat_rate: true, line_total: true, line_vat: true } } },
  })) as Array<{ id: string; lines: Array<{ vat_rate: unknown; line_total: unknown; line_vat: unknown }> }>;

  const rates = new Map<number, VatRateRow>();
  let netPennies = 0, vatPennies = 0;
  for (const inv of invoices) {
    for (const l of inv.lines) {
      const net = pennies(l.line_total), vat = pennies(l.line_vat);
      const ratePercent = Number(l.vat_rate ?? 0);
      netPennies += net; vatPennies += vat;
      const row = rates.get(ratePercent) ?? { ratePercent, netPennies: 0, vatPennies: 0, lineCount: 0 };
      row.netPennies += net; row.vatPennies += vat; row.lineCount += 1;
      rates.set(ratePercent, row);
    }
  }

  return {
    fromISO: from.toISOString(), toISO: to.toISOString(),
    invoiceCount: invoices.length,
    netPennies, vatPennies, grossPennies: netPennies + vatPennies,
    byRate: [...rates.values()].sort((a, b) => b.ratePercent - a.ratePercent),
  };
}
