/**
 * File: lib/vat-summary.ts
 * THE output-VAT aggregation for the accountant's VAT-on-sales summary. OUTPUT VAT ONLY — it sums the
 * FROZEN per-line tax on every invoice lib/invoice-series-scope::VAT_RETURN_TREATMENT declares as lines —
 * workshop work and QUALIFYING car sales — plus margin-scheme VAT from the stock book in its own section
 * (never re-derives lines; same freeze-at-issue discipline
 * as aggregateFrozenTax), filtered by effectiveIssueDate. It deliberately does NOT touch input/purchase
 * VAT: parts unit_cost is an internal margin cost (not a VAT-coded purchase) and overheads are recurring
 * budget entries (not dated purchase invoices), so no defensible input-VAT figure exists — it is omitted,
 * and the report is labelled as VAT on sales only, not a complete return.
 */
import { prisma } from '@/lib/db';
import { effectiveIssueDateWhere } from '@/lib/invoice';
import { vatTreatment } from '@/lib/invoice-series-scope';
import { bookRow, type DisposalKind } from '@/lib/stock';
import { marginBaseFeePence, type PurchaseSource } from '@/lib/purchase-model';

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
  /**
   * CARS SOLD UNDER THE MARGIN SCHEME, in their own section and NOT in the figures above. VAT is on the
   * margin — sale less the price of the goods, premium included — floored at zero per car, from the stock
   * book (lib/stock::bookRow). How a margin sale enters NET SALES is the accountant's call (list item 12),
   * so netPennies and byRate are deliberately untouched by it.
   */
  marginScheme: {
    count: number; salePennies: number; basePennies: number; marginPennies: number; vatPennies: number;
    rows: Array<{ invoiceNumber: string; registration: string | null; salePennies: number; basePennies: number; marginPennies: number; vatPennies: number }>;
  };
  /** Output VAT on invoiced lines PLUS VAT on margin-scheme sales. Shown beside, never instead of, vatPennies. */
  totalOutputVatPennies: number;
  /**
   * REFUSED, VISIBLY. Sales that could not be classified are in NO figure on this report and are named
   * here by invoice number, because a return filed without them is wrong and one that guessed is worse.
   */
  unclassified: Array<{ invoiceNumber: string; reason: string }>;
};

const pennies = (d: unknown): number => Math.round(Number(d ?? 0) * 100);

/** Output VAT for [from, to) over the caller's visible sites. Chargeable + issued only; frozen tax. */
export async function getVatSummary(groupId: string, siteIds: string[], from: Date, to: Date): Promise<VatSummary> {
  // EVERY SERIES IS FETCHED AND THE RULE DECIDES (lib/invoice-series-scope::VAT_RETURN_TREATMENT). This
  // used to name `series: 'chargeable'`, which left a qualifying car's output VAT out of the return and
  // gave margin VAT nowhere to go at all. Filtering the series here as well would be a second spelling
  // of the rule, and the next series would be answered by whichever copy was edited.
  const fetched = (await prisma.invoice.findMany({
    where: {
      group_id: groupId,
      site_id: { in: siteIds },
      // POSITIVE ALLOW-LIST — already excludes 'void' by construction, so it needs no predicate.
      // Do NOT spread `notVoided` in here: the later `status` key would WIN and widen this to
      // "anything except void", pulling settled warranty rows into the VAT return.
      status: { in: ['issued', 'paid_pending', 'paid'] },    // has a number; 'settled' = warranty terminal
      ...effectiveIssueDateWhere(from, to),
    },
    select: {
      id: true, invoice_number: true, series: true, vat_position: true, vat_registered_at_issue: true, stock_disposal_id: true,
      lines: { select: { vat_rate: true, line_total: true, line_vat: true } },
    },
  })) as Array<{
    id: string; invoice_number: string | null; series: string; vat_position: string | null; vat_registered_at_issue: boolean;
    stock_disposal_id: string | null; lines: Array<{ vat_rate: unknown; line_total: unknown; line_vat: unknown }>;
  }>;

  const invoices: typeof fetched = [];
  const marginInvoices: typeof fetched = [];
  const unclassified: VatSummary['unclassified'] = [];
  for (const inv of fetched) {
    const treatment = vatTreatment(inv.series, { vatPosition: inv.vat_position, registeredAtIssue: inv.vat_registered_at_issue });
    if (treatment === 'output_lines') invoices.push(inv);
    else if (treatment === 'margin_scheme') marginInvoices.push(inv);
    else if (treatment === 'unclassified') {
      unclassified.push({ invoiceNumber: inv.invoice_number ?? inv.id, reason: `a ${inv.series} invoice whose VAT treatment is ${inv.vat_position === null ? 'not recorded' : `"${inv.vat_position}"`}` });
    }
  }

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
  // existed every refund left this figure overstated (accountant's ruling, 2026-08-16).
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

  // ── THE MARGIN SCHEME, FROM THE STOCK BOOK ───────────────────────────────────────────────────────
  // The invoice decides WHICH cars; the book decides WHAT IS DUE. Any disagreement between the two —
  // no stock record, a stock record on the other scheme, a price that differs from the invoice — is
  // refused visibly rather than resolved by picking a side.
  const disposalIds = marginInvoices.map((i) => i.stock_disposal_id).filter((x): x is string => !!x);
  const disposals = disposalIds.length ? await prisma.stockDisposal.findMany({
    where: { id: { in: disposalIds }, group_id: groupId },
    select: {
      id: true, kind: true, sale_pence: true,
      stock_item: { select: { purchase_pence: true, premium_pence: true, source: true, vat_status: true, vehicle: { select: { registration: true } } } },
    },
  }) : [];
  const byDisposal = new Map(disposals.map((d) => [d.id, d]));
  const margin: VatSummary['marginScheme'] = { count: 0, salePennies: 0, basePennies: 0, marginPennies: 0, vatPennies: 0, rows: [] };
  for (const inv of marginInvoices) {
    const number = inv.invoice_number ?? inv.id;
    const d = inv.stock_disposal_id ? byDisposal.get(inv.stock_disposal_id) : undefined;
    if (!d) { unclassified.push({ invoiceNumber: number, reason: 'a margin-scheme sale with no stock record to take the margin from' }); continue; }
    if (d.stock_item.vat_status !== 'margin') {
      unclassified.push({ invoiceNumber: number, reason: `the invoice says margin scheme but the car was bought as ${d.stock_item.vat_status}` });
      continue;
    }
    const invoiceGross = inv.lines.reduce((a, l) => a + pennies(l.line_total) + pennies(l.line_vat), 0);
    if (d.sale_pence === null || d.sale_pence !== invoiceGross) {
      unclassified.push({ invoiceNumber: number, reason: `the invoice total and the recorded sale price disagree (${invoiceGross} vs ${d.sale_pence ?? 'none'} pence)` });
      continue;
    }
    const base = d.stock_item.purchase_pence + marginBaseFeePence(d.stock_item.source as PurchaseSource, d.stock_item.premium_pence);
    const row = bookRow({
      purchasePence: d.stock_item.purchase_pence,
      inMarginBasePence: marginBaseFeePence(d.stock_item.source as PurchaseSource, d.stock_item.premium_pence),
      vatStatus: 'margin', disposal: { kind: d.kind as DisposalKind, salePence: d.sale_pence },
    });
    if (row.vatDuePence === null || row.marginPence === null) {
      unclassified.push({ invoiceNumber: number, reason: 'the stock book gives no margin figure for this sale' });
      continue;
    }
    margin.count += 1;
    margin.salePennies += d.sale_pence;
    margin.basePennies += base;
    margin.marginPennies += row.marginPence;
    margin.vatPennies += row.vatDuePence;
    margin.rows.push({ invoiceNumber: number, registration: d.stock_item.vehicle?.registration ?? null, salePennies: d.sale_pence, basePennies: base, marginPennies: row.marginPence, vatPennies: row.vatDuePence });
  }

  return {
    fromISO: from.toISOString(), toISO: to.toISOString(),
    invoiceCount: invoices.length,
    creditNoteCount: creditNotes.length,
    creditedNetPennies, creditedVatPennies,
    netPennies, vatPennies, grossPennies: netPennies + vatPennies,
    byRate: [...rates.values()].sort((a, b) => b.ratePercent - a.ratePercent),
    marginScheme: margin,
    totalOutputVatPennies: vatPennies + margin.vatPennies,
    unclassified,
  };
}
