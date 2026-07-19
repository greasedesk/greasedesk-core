/**
 * File: lib/charged-labour.ts
 * THE charged-labour-hours read — the utilisation NUMERATOR, extracted VERBATIM from the P&L
 * compute (MONTH_TILE_COMPUTES.pnl) so both read the same ledger the same way. Shared by the
 * P&L strip (all visible sites) and getUtilisation (single-site: siteIds = [siteId]).
 *
 * Hours charged = fixed lines' labour_hours × qty + ad-hoc labour lines' qty (qty IS hours).
 * COMEBACK/WARRANTY BEHAVIOUR (ruling 2026-07-12 — SUPERSEDES the earlier "count warranty hours
 * as charged" ruling): rework is SPENT capacity, not sold output. Warranty invoices' labour
 * hours are EXCLUDED from `centihours` (the utilisation numerator / "hours charged" tile count
 * billable work only — 8h honestly recorded on a comeback must not raise utilisation) and
 * returned separately as `reworkCentihours`, so every clock hour stays accounted for:
 * sold / rework / absent / unsold. Parts cost still drags the P&L; revenue stays £0.
 */
import { prisma } from '@/lib/db';
import { effectiveIssueDateWhere } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';

export type LedgerInvoice = {
  series: string;
  id?: string;
  invoice_number?: string | null;
  lines: Array<{ item_type: string | null; qty: unknown; unit_price: unknown; unit_cost: unknown; labour_hours: unknown; labour_outsourced?: boolean; catalogue_item_id?: string | null }>;
};

/** The ONE ledger fetch for month-grained invoice reads (P&L + utilisation): invoices whose
 *  EFFECTIVE issue date falls in [from, to), with their FROZEN InvoiceLine rows (freeze-at-issue
 *  ruling 2026-07-12 — the ledger NEVER reads the mutable JobCardItem; the card is the working
 *  draft only). item_type/labour_outsourced are the frozen classification, populated on every
 *  row by the 2026-07-12 backfill + every new snapshot. */
export function fetchLedgerInvoices(ctx: { groupId: string; siteIds: string[]; from: Date; to: Date }): Promise<LedgerInvoice[]> {
  return prisma.invoice.findMany({
    where: { group_id: ctx.groupId, site_id: { in: ctx.siteIds }, ...effectiveIssueDateWhere(ctx.from, ctx.to) },
    select: { series: true, id: true, invoice_number: true, lines: { select: { item_type: true, qty: true, unit_price: true, unit_cost: true, labour_hours: true, labour_outsourced: true, catalogue_item_id: true } } },
  }) as unknown as Promise<LedgerInvoice[]>;
}

export type ChargedLabour = { centihours: number; reworkCentihours: number; linesMissingHours: number };

/** Parts-cost drag of a set of ledger invoices — THE P&L's parts-cost read (extracted verbatim
 *  from MONTH_TILE_COMPUTES.pnl; goldens prove the extraction changed nothing): every non-labour
 *  line's qty × unit_cost. Comeback drag by construction: cost counts even at £0 revenue. */
export function partsCostPennies(invoices: LedgerInvoice[]): number {
  let partsCost = 0;
  for (const inv of invoices) {
    for (const it of inv.lines ?? []) {
      if (it.item_type === 'labour') continue;
      if (it.unit_cost == null) continue; // cost UNKNOWN — EXCLUDED from margin, never counted as zero
      partsCost += Math.round(Number(it.qty) * poundsToPennies(Number(it.unit_cost)));
    }
  }
  return partsCost;
}

export type UncostedParts = { lines: number; retailPennies: number; invoices: Array<{ id: string; number: string; lines: number }> };

/** The parts-cost EXPOSURE — GENUINELY un-costed ad-hoc parts: a non-labour line with NO catalogue
 *  link, POSITIVE retail, and NO recorded trade cost (null = unknown, or a legacy 0 saved before
 *  the null model). These inflate gross margin (revenue with no cost offset → shown at 100%), so we
 *  surface them: the margin is never silently trusted. Discounts / warranty credits (negative retail)
 *  and catalogue-linked lines are correctly excluded. Retail = qty × unit_price (ex VAT); per-invoice
 *  breakdown drives the dashboard drill. */
export function uncostedParts(invoices: LedgerInvoice[]): UncostedParts {
  let lines = 0, retailPennies = 0;
  const byInvoice: Array<{ id: string; number: string; lines: number }> = [];
  for (const inv of invoices) {
    let invLines = 0;
    for (const it of inv.lines ?? []) {
      if (it.item_type === 'labour') continue;
      if (it.catalogue_item_id != null) continue;       // catalogue-linked → cost is known/inherited
      if (Number(it.unit_price) <= 0) continue;          // discount / warranty credit → not a supplied part
      if (it.unit_cost != null && Number(it.unit_cost) !== 0) continue; // a real trade cost is recorded
      invLines += 1; retailPennies += Math.round(Number(it.qty) * poundsToPennies(Number(it.unit_price)));
    }
    if (invLines > 0) { lines += invLines; byInvoice.push({ id: inv.id ?? '', number: inv.invoice_number ?? '', lines: invLines }); }
  }
  return { lines, retailPennies, invoices: byInvoice };
}

/** Charged labour CONTENT of a set of ledger invoices (see module header for the grain):
 *  billable hours in `centihours`, warranty-rework hours in `reworkCentihours` — same grain,
 *  split by the invoice's series. Missing-hours lines flag on BOTH (either undercounts). */
/**
 * THE one resolution of "how many of our hours does this line represent", in centihours.
 *
 * LABOUR lines: `labour_hours` is AUTHORITATIVE when present and is the LINE TOTAL, not a per-unit
 * figure; qty-as-hours is the fallback when it is null. Native ad-hoc labour is entered as
 * qty = hours and leaves labour_hours null (verified: 0 of 25 ledger rows and 0 of 44 card rows set
 * it), so the fallback preserves every existing figure exactly. Imported labour is the case that
 * needs the override: an invoice line reading "Fit front wheel bearings, qty 1, £150.00" is one
 * line, not one hour, and the operator's entered hours are the true figure.
 *
 * FIXED lines are unchanged: labour_hours is the PRODUCT's per-unit definition, so qty multiplies.
 *
 * Exported because the import wizard seeds its booking duration from the same question. Two readers
 * computing hours differently is precisely the defect this replaces — staged.ts multiplied
 * labour_hours by qty while this function ignored labour_hours entirely.
 */
export function lineLabourCentihours(it: {
  item_type: string | null; qty: unknown; labour_hours: unknown; labour_outsourced?: boolean;
}): { centihours: number; missingHours: boolean } {
  const qty = Number(it.qty);
  if (it.item_type === 'labour') {
    if (it.labour_hours != null) return { centihours: Math.round(Number(it.labour_hours) * 100), missingHours: false };
    return { centihours: Math.round(qty * 100), missingHours: false };
  }
  if (it.item_type === 'fixed') {
    // OUTSOURCED lines are INVISIBLE here (settled model): bought-in labour is cost of sale — its
    // labour_hours means CUSTOMER-BILLED hours (prices the job) and must never claim own payroll
    // capacity (numerator) nor nag the amber (zero own-hours is CORRECT for an MOT).
    if (it.labour_outsourced) return { centihours: 0, missingHours: false };
    if (it.labour_hours == null) return { centihours: 0, missingHours: true };
    return { centihours: Math.round(qty * Number(it.labour_hours) * 100), missingHours: false };
  }
  return { centihours: 0, missingHours: false };
}

export function chargedLabourCentihours(invoices: LedgerInvoice[]): ChargedLabour {
  let centihours = 0, reworkCentihours = 0, linesMissingHours = 0;
  for (const inv of invoices) {
    const rework = inv.series === 'warranty'; // spent capacity, never sold output
    const add = (c: number) => { if (rework) reworkCentihours += c; else centihours += c; };
    for (const it of inv.lines ?? []) {
      const r = lineLabourCentihours(it);
      if (r.missingHours) linesMissingHours += 1; // a PAYROLL-time product with no hours set
      else if (r.centihours) add(r.centihours);
    }
  }
  return { centihours, reworkCentihours, linesMissingHours };
}
