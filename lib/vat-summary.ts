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
  /** How many credit notes were subtracted. Reported, so a period that nets down says WHY. */
  creditNoteCount: number;
  /** The credited figures, BEFORE subtraction — so the report can show them as their own line. */
  creditedNetPennies: number;
  creditedVatPennies: number;
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
      // POSITIVE ALLOW-LIST — already excludes 'void' by construction, so it needs no predicate.
      // Do NOT spread `notVoided` in here: the later `status` key would WIN and widen this to
      // "anything except void", pulling settled warranty rows into the VAT return.
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

  // ── CREDIT NOTES, SUBTRACTED ─────────────────────────────────────────────────────────────────
  // A refunded stamp proves the payment event; it does not reverse output VAT. Until credit notes
  // existed every refund left this figure overstated (accountant's ruling, 2026-08-17).
  //
  // Dated on `date_issued` — the credit note's OWN date, confirmed by a person. That is the VAT
  // clock, and it is allowed to fall in a different period from the refund that occasioned it: the
  // cash clock lives in lib/payments::receivedInPeriod and answers a different question.
  //
  // No `status` filter: a credit note has no lifecycle. It exists or it does not.
  const creditNotes = (await prisma.creditNote.findMany({
    where: {
      group_id: groupId,
      site_id: { in: siteIds },
      date_issued: { gte: from, lt: to },
      // Only corrections to documents that were themselves declared. A credit note against a
      // non-chargeable invoice cannot exist (lib/credit-note::vatPosition refuses to require one),
      // but the join is named rather than assumed — see the stated-predicate rule.
      invoice: { is: { series: 'chargeable' } },
    },
    select: { id: true, lines: { select: { vat_rate: true, line_total: true, line_vat: true } } },
  })) as Array<{ id: string; lines: Array<{ vat_rate: unknown; line_total: unknown; line_vat: unknown }> }>;

  let creditedNetPennies = 0, creditedVatPennies = 0;
  for (const cn of creditNotes) {
    for (const l of cn.lines) {
      // Lines are stored POSITIVE; the document's sign lives in its type. Subtract here, once.
      const net = pennies(l.line_total), vat = pennies(l.line_vat);
      const ratePercent = Number(l.vat_rate ?? 0);
      creditedNetPennies += net; creditedVatPennies += vat;
      netPennies -= net; vatPennies -= vat;
      const row = rates.get(ratePercent) ?? { ratePercent, netPennies: 0, vatPennies: 0, lineCount: 0 };
      row.netPennies -= net; row.vatPennies -= vat; row.lineCount += 1;
      rates.set(ratePercent, row);
    }
  }

  return {
    fromISO: from.toISOString(), toISO: to.toISOString(),
    invoiceCount: invoices.length,
    creditNoteCount: creditNotes.length,
    creditedNetPennies, creditedVatPennies,
    netPennies, vatPennies, grossPennies: netPennies + vatPennies,
    byRate: [...rates.values()].sort((a, b) => b.ratePercent - a.ratePercent),
  };
}
