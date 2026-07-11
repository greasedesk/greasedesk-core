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
import { invoiceTotals, computeInvoiceLinePennies, effectivePaidDate, effectiveIssueDateWhere } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';
import { fetchLedgerInvoices, chargedLabourCentihours } from '@/lib/charged-labour';

export type TileContext = { groupId: string; siteIds: string[]; from: Date; to: Date };
export type MonthTileContext = TileContext & { months: number };

// Date bases (ONE chokepoint each, lib/invoice): paid tiles bucket by effectivePaidDate
// (date_paid ?? paid_at — cash basis); issued/warranty/P&L bucket by the effective ISSUE date
// (date_issued ?? issued_at — billing basis) via effectiveIssueDateWhere.

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
      where: { group_id: groupId, site_id: { in: siteIds }, series: 'chargeable', ...effectiveIssueDateWhere(from, to) },
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
      where: { group_id: groupId, site_id: { in: siteIds }, series: 'warranty', ...effectiveIssueDateWhere(from, to) },
    });
    return { count };
  },
};

// ---------- Month-grained P&L (the profit strip) ----------
// ONE registered compute produces the five P&L figures from a single ledger pass — calendar-month
// grained BY DESIGN (the wage bill is a monthly lump; partial-month labour profit is fiction).
// Line grain: the card's items (item_type lives there; card lines LOCK at paid so they equal the
// frozen snapshot; while issued they're the live truth — same one-object ledger). Ex-VAT
// throughout: this is a profit statement, VAT is not revenue.
//  Revenue (invoiced, ex-VAT) → − Parts cost → Gross margin → − wages − overheads → Net profit.
//  Plus the operational grain: Hours charged (fixed-service labour_hours + ad-hoc labour qty).
export const MONTH_TILE_COMPUTES: Record<string, (ctx: MonthTileContext) => Promise<unknown>> = {
  pnl: async ({ groupId, siteIds, from, to, months }) => {
    const invoices = await fetchLedgerInvoices({ groupId, siteIds, from, to }); // the ONE ledger read (shared with utilisation)

    // The HONEST chain (ruling 2026-07-10 — replaces the parts/labour margin split, which
    // pretended a decomposition the fixed-price model doesn't make: fixed lines bake labour into
    // the margin): Revenue − Parts cost = Gross margin; Net = margin − wages − overheads.
    let revenueNet = 0, partsCost = 0;
    for (const inv of invoices) {
      const warranty = inv.series === 'warranty';
      for (const it of inv.job_card?.items ?? []) {
        const qty = Number(it.qty);
        const net = computeInvoiceLinePennies(qty, poundsToPennies(Number(it.unit_price)), 0, false).netPennies;
        if (!warranty) revenueNet += net;
        if (it.item_type !== 'labour') {
          partsCost += Math.round(qty * poundsToPennies(Number(it.unit_cost))); // comeback drag: cost counts even at £0 revenue
        }
      }
    }
    // Hours charged — the EXTRACTED numerator (lib/charged-labour), reused verbatim by
    // getUtilisation. Grain + comeback behaviour documented at the helper.
    const { centihours: hoursChargedCentihours, linesMissingHours } = chargedLabourCentihours(invoices);

    // Wage bill: active SALARIED people only (hourly staff have no hours source until clocking
    // lands — surfaced in the tile note), annual ÷ 12, scaled by their allocation to the visible
    // sites. Costs are TODAY'S settings applied to each month in the span.
    const people = (await prisma.costPerson.findMany({
      where: { group_id: groupId, is_active: true, cost_type: 'salary' },
      select: { amount_pennies: true, allocations: { where: { site_id: { in: siteIds } }, select: { percent: true } } },
    })) as any[];
    const wageBillMonthly = Math.round(people.reduce((a, p2) =>
      a + (p2.amount_pennies / 12) * p2.allocations.reduce((s: number, al: any) => s + Number(al.percent), 0) / 100, 0));

    // Operating overheads (the Overheads register — rent/rates for TMBS), normalised monthly,
    // allocation-scaled. NO name-matching — the register IS the list. Wages are NOT here (they
    // live in Headcount), so the net line can never double-count them.
    const overheads = (await prisma.overhead.findMany({
      where: { group_id: groupId, is_active: true },
      select: { ex_vat_amount_pennies: true, period: true, allocations: { where: { site_id: { in: siteIds } }, select: { percent: true } } },
    })) as any[];
    const monthlyOf = (o: any) => o.period === 'annual' ? o.ex_vat_amount_pennies / 12 : o.period === 'weekly' ? (o.ex_vat_amount_pennies * 52) / 12 : o.ex_vat_amount_pennies;
    const overheadsMonthly = Math.round(overheads.reduce((a, o) =>
      a + monthlyOf(o) * o.allocations.reduce((s: number, al: any) => s + Number(al.percent), 0) / 100, 0));

    const grossMargin = revenueNet - partsCost;
    const wageBill = wageBillMonthly * months;
    const operatingCosts = overheadsMonthly * months;
    // Labour contribution: on the fixed-price model the margin IS the labour income (parts are
    // the only other cost) — so contribution = grossMargin − wageBill. SAME fields the net line
    // uses; by construction contribution − operatingCosts === netProfit.
    const labourContribution = grossMargin - wageBill;
    const netProfit = grossMargin - wageBill - operatingCosts; // wages counted ONCE, here
    return { revenueNet, partsCost, grossMargin, hoursChargedCentihours, linesMissingHours, wageBill, labourContribution, operatingCosts, netProfit, months, invoiceCount: invoices.length };
  },
};

export async function computeTiles(ctx: TileContext, monthCtx?: MonthTileContext): Promise<Record<string, unknown>> {
  const entries = await Promise.all([
    ...Object.entries(TILE_COMPUTES).map(async ([key, fn]) => [key, await fn(ctx)] as const),
    ...(monthCtx ? Object.entries(MONTH_TILE_COMPUTES).map(async ([key, fn]) => [key, await fn(monthCtx)] as const) : []),
  ]);
  return Object.fromEntries(entries);
}
