/**
 * File: lib/dashboard-tiles.ts
 * THE dashboard tile registry (server side). A tile = one entry in TILE_COMPUTES: an async compute
 * over a TileContext (tenant + visible sites + period). Adding a tile = add a compute here + a
 * renderer entry in the page's client registry — never a page rewrite. Every compute is scoped by
 * ctx.siteIds (server-side; an admin gets all group sites, a manager only theirs) and reads the
 * SAME financial truth as the Invoices view: invoice rows + the money chokepoints (snapshot lines
 * once paid, live card items while issued). No money logic is re-implemented here.
 */
import { prisma } from '@/lib/db';
import { invoiceTotals, computeInvoiceLinePennies } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';

export type TileContext = { groupId: string; siteIds: string[]; from: Date; to: Date };

// Revenue recognition date for a confirmed invoice: the DOCUMENT fact (date_paid), falling back
// to the attestation (paid_at) for invoices paid before date_paid existed.
const effectivePaidDate = (r: { date_paid: Date | null; paid_at: Date | null }) => r.date_paid ?? r.paid_at;

const PAID_SELECT = { site_id: true, date_paid: true, paid_at: true, lines: { select: { vat_rate: true, line_total: true, line_vat: true } }, site: { select: { site_name: true } } } as const;
const grossOfPaid = (r: any) => invoiceTotals(r.lines).grossPennies;
const grossOfIssued = (r: any) => {
  const registered = !!r.vat_registered_at_issue;
  let g = 0;
  for (const it of r.job_card?.items ?? []) {
    const { netPennies, vatPennies } = computeInvoiceLinePennies(Number(it.qty), poundsToPennies(Number(it.unit_price)), Number(it.vat_rate), registered);
    g += netPennies + vatPennies;
  }
  return g;
};

export const TILE_COMPUTES: Record<string, (ctx: TileContext) => Promise<unknown>> = {
  // Confirmed paid revenue in the period (paid ledger; three-state: only `paid` counts).
  revenue: async ({ groupId, siteIds, from, to }) => {
    const rows = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, status: 'paid', series: 'chargeable' },
      select: PAID_SELECT,
    })) as any[];
    const inPeriod = rows.filter((r) => { const d = effectivePaidDate(r); return d && d >= from && d < to; });
    const bySite = new Map<string, { site: string; grossPennies: number }>();
    let total = 0;
    for (const r of inPeriod) {
      const g = grossOfPaid(r);
      total += g;
      const cur = bySite.get(r.site_id) ?? { site: r.site?.site_name ?? '—', grossPennies: 0 };
      cur.grossPennies += g;
      bySite.set(r.site_id, cur);
    }
    return { grossPennies: total, count: inPeriod.length, perSite: bySite.size > 1 ? Array.from(bySite.values()) : [] };
  },

  // Issued vs paid in the period — count + value each way.
  issuedVsPaid: async ({ groupId, siteIds, from, to }) => {
    const issued = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, series: 'chargeable', issued_at: { gte: from, lt: to } },
      select: { status: true, vat_registered_at_issue: true, lines: { select: { vat_rate: true, line_total: true, line_vat: true } }, job_card: { select: { items: { select: { qty: true, unit_price: true, vat_rate: true } } } } },
    })) as any[];
    const issuedPennies = issued.reduce((a, r) => a + (r.status === 'issued' ? grossOfIssued(r) : grossOfPaid(r)), 0);
    const paidRows = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, status: 'paid', series: 'chargeable' },
      select: PAID_SELECT,
    })) as any[];
    const paidInPeriod = paidRows.filter((r) => { const d = effectivePaidDate(r); return d && d >= from && d < to; });
    return {
      issuedCount: issued.length, issuedPennies,
      paidCount: paidInPeriod.length, paidPennies: paidInPeriod.reduce((a, r) => a + grossOfPaid(r), 0),
    };
  },

  // Pending clearance: money CURRENTLY in the paid_pending window (marked paid, not yet confirmed).
  // Point-in-time like Debtors — a pending row lives ≤7 days, so a period filter would only hide
  // live clearance money. Value from the frozen snapshot lines (pending IS frozen).
  pendingClearance: async ({ groupId, siteIds }) => {
    const rows = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, status: 'paid_pending', series: 'chargeable' },
      select: { lines: { select: { vat_rate: true, line_total: true, line_vat: true } } },
    })) as any[];
    return { grossPennies: rows.reduce((a, r) => a + grossOfPaid(r), 0), count: rows.length };
  },

  // Debtors: CURRENT outstanding (unpaid chargeable) — a point-in-time AR figure, period-independent.
  debtors: async ({ groupId, siteIds }) => {
    const rows = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, status: 'issued', series: 'chargeable' },
      select: { vat_registered_at_issue: true, job_card: { select: { items: { select: { qty: true, unit_price: true, vat_rate: true } } } } },
    })) as any[];
    return { grossPennies: rows.reduce((a, r) => a + grossOfIssued(r), 0), count: rows.length };
  },

  // Warranty/comeback jobs in the period — warranty-series invoices minted in range (the filter
  // key the series was designed to be).
  warranty: async ({ groupId, siteIds, from, to }) => {
    const count = await prisma.invoice.count({
      where: { group_id: groupId, site_id: { in: siteIds }, series: 'warranty', issued_at: { gte: from, lt: to } },
    });
    return { count };
  },
};

export async function computeTiles(ctx: TileContext): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(TILE_COMPUTES).map(async ([key, fn]) => [key, await fn(ctx)] as const),
  );
  return Object.fromEntries(entries);
}
