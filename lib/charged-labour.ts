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
  lines: Array<{ item_type: string | null; qty: unknown; unit_price: unknown; unit_cost: unknown; labour_hours: unknown; labour_outsourced?: boolean }>;
};

/** The ONE ledger fetch for month-grained invoice reads (P&L + utilisation): invoices whose
 *  EFFECTIVE issue date falls in [from, to), with their FROZEN InvoiceLine rows (freeze-at-issue
 *  ruling 2026-07-12 — the ledger NEVER reads the mutable JobCardItem; the card is the working
 *  draft only). item_type/labour_outsourced are the frozen classification, populated on every
 *  row by the 2026-07-12 backfill + every new snapshot. */
export function fetchLedgerInvoices(ctx: { groupId: string; siteIds: string[]; from: Date; to: Date }): Promise<LedgerInvoice[]> {
  return prisma.invoice.findMany({
    where: { group_id: ctx.groupId, site_id: { in: ctx.siteIds }, ...effectiveIssueDateWhere(ctx.from, ctx.to) },
    select: { series: true, lines: { select: { item_type: true, qty: true, unit_price: true, unit_cost: true, labour_hours: true, labour_outsourced: true } } },
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
      if (it.item_type !== 'labour') partsCost += Math.round(Number(it.qty) * poundsToPennies(Number(it.unit_cost)));
    }
  }
  return partsCost;
}

/** Charged labour CONTENT of a set of ledger invoices (see module header for the grain):
 *  billable hours in `centihours`, warranty-rework hours in `reworkCentihours` — same grain,
 *  split by the invoice's series. Missing-hours lines flag on BOTH (either undercounts). */
export function chargedLabourCentihours(invoices: LedgerInvoice[]): ChargedLabour {
  let centihours = 0, reworkCentihours = 0, linesMissingHours = 0;
  for (const inv of invoices) {
    const rework = inv.series === 'warranty'; // spent capacity, never sold output
    const add = (c: number) => { if (rework) reworkCentihours += c; else centihours += c; };
    for (const it of inv.lines ?? []) {
      const qty = Number(it.qty);
      if (it.item_type === 'labour') {
        add(Math.round(qty * 100)); // ad-hoc labour: qty IS hours
      } else if (it.item_type === 'fixed') {
        // OUTSOURCED lines are INVISIBLE here (settled model): bought-in labour is cost of sale —
        // its labour_hours means CUSTOMER-BILLED hours (prices the job) and must never claim own
        // payroll capacity (numerator) nor nag the amber (zero own-hours is CORRECT for an MOT).
        if (it.labour_outsourced) continue;
        if (it.labour_hours == null) linesMissingHours += 1; // a PAYROLL-time product with no hours set
        else add(Math.round(qty * Number(it.labour_hours) * 100));
      }
    }
  }
  return { centihours, reworkCentihours, linesMissingHours };
}
