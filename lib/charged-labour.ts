/**
 * File: lib/charged-labour.ts
 * THE charged-labour-hours read — the utilisation NUMERATOR, extracted VERBATIM from the P&L
 * compute (MONTH_TILE_COMPUTES.pnl) so both read the same ledger the same way. Shared by the
 * P&L strip (all visible sites) and getUtilisation (single-site: siteIds = [siteId]).
 *
 * Hours charged = fixed lines' labour_hours × qty + ad-hoc labour lines' qty (qty IS hours).
 * COMEBACK/WARRANTY BEHAVIOUR — INTENDED, not a bug: warranty invoices' lines still contribute
 * their labour hours (the rework consumed real capacity/content) and their parts cost drags the
 * P&L, while contributing £0 revenue. Utilisation therefore counts comeback hours as charged
 * content — do not "fix" this to skip warranty invoices.
 */
import { prisma } from '@/lib/db';
import { effectiveIssueDateWhere } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';

export type LedgerInvoice = {
  series: string;
  job_card: { items: Array<{ item_type: string; qty: unknown; unit_price: unknown; unit_cost: unknown; labour_hours: unknown; labour_outsourced?: boolean }> } | null;
};

/** The ONE ledger fetch for month-grained invoice reads (P&L + utilisation): invoices whose
 *  EFFECTIVE issue date falls in [from, to), with their card items. */
export function fetchLedgerInvoices(ctx: { groupId: string; siteIds: string[]; from: Date; to: Date }): Promise<LedgerInvoice[]> {
  return prisma.invoice.findMany({
    where: { group_id: ctx.groupId, site_id: { in: ctx.siteIds }, ...effectiveIssueDateWhere(ctx.from, ctx.to) },
    select: { series: true, job_card: { select: { items: { select: { item_type: true, qty: true, unit_price: true, unit_cost: true, labour_hours: true, labour_outsourced: true } } } } },
  }) as unknown as Promise<LedgerInvoice[]>;
}

export type ChargedLabour = { centihours: number; linesMissingHours: number };

/** Parts-cost drag of a set of ledger invoices — THE P&L's parts-cost read (extracted verbatim
 *  from MONTH_TILE_COMPUTES.pnl; goldens prove the extraction changed nothing): every non-labour
 *  line's qty × unit_cost. Comeback drag by construction: cost counts even at £0 revenue. */
export function partsCostPennies(invoices: LedgerInvoice[]): number {
  let partsCost = 0;
  for (const inv of invoices) {
    for (const it of inv.job_card?.items ?? []) {
      if (it.item_type !== 'labour') partsCost += Math.round(Number(it.qty) * poundsToPennies(Number(it.unit_cost)));
    }
  }
  return partsCost;
}

/** Charged labour CONTENT of a set of ledger invoices (see module header for the grain). */
export function chargedLabourCentihours(invoices: LedgerInvoice[]): ChargedLabour {
  let centihours = 0, linesMissingHours = 0;
  for (const inv of invoices) {
    for (const it of inv.job_card?.items ?? []) {
      const qty = Number(it.qty);
      if (it.item_type === 'labour') {
        centihours += Math.round(qty * 100); // ad-hoc labour: qty IS hours
      } else if (it.item_type === 'fixed') {
        // OUTSOURCED lines are INVISIBLE here (settled model): bought-in labour is cost of sale —
        // its labour_hours means CUSTOMER-BILLED hours (prices the job) and must never claim own
        // payroll capacity (numerator) nor nag the amber (zero own-hours is CORRECT for an MOT).
        if (it.labour_outsourced) continue;
        if (it.labour_hours == null) linesMissingHours += 1; // a PAYROLL-time product with no hours set
        else centihours += Math.round(qty * Number(it.labour_hours) * 100);
      }
    }
  }
  return { centihours, linesMissingHours };
}
