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
import { fetchLedgerInvoices, chargedLabourCentihours, partsCostPennies, uncostedParts } from '@/lib/charged-labour';
import { getGroupUtilisation } from '@/lib/capacity';

export type TileContext = { groupId: string; siteIds: string[]; from: Date; to: Date };
export type MonthTileContext = TileContext & { months: number };

// Date bases (ONE chokepoint each, lib/invoice): paid tiles bucket by effectivePaidDate
// (date_paid ?? paid_at — cash basis); issued/warranty/P&L bucket by the effective ISSUE date
// (date_issued ?? issued_at — billing basis) via effectiveIssueDateWhere.

const PAID_SELECT = { site_id: true, date_paid: true, paid_at: true, lines: { select: { vat_rate: true, line_total: true, line_vat: true } }, site: { select: { site_name: true } } } as const;
// FREEZE-AT-ISSUE: every invoice carries frozen lines from mint, so issued and paid money read
// the SAME snapshot — one gross, no live-card recomputation anywhere in the tiles.
const grossOfPaid = (r: any) => invoiceTotals(r.lines).grossPennies;
const grossOfIssued = grossOfPaid;

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
      select: { status: true, lines: { select: { vat_rate: true, line_total: true, line_vat: true } } },
    })) as any[];
    const issuedPennies = issued.reduce((a, r) => a + grossOfPaid(r), 0); // frozen lines from mint — one gross for every status
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
      select: { lines: { select: { vat_rate: true, line_total: true, line_vat: true } } },
    })) as any[];
    return { grossPennies: rows.reduce((a, r) => a + grossOfIssued(r), 0), count: rows.length };
  },

  // Warranty/comeback jobs in the period — the TRUE cost of rework, not just a count: parts £
  // (real money spent redoing work for free) + labour hours consumed, valued at the site labour
  // rate. READ-ONLY over the same ledger grain as the P&L: parts via partsCostPennies, hours via
  // chargedLabourCentihours (both lib/charged-labour — never re-derived). £0 revenue on the
  // warranty series is untouched — this tile only SURFACES cost, it never changes invoicing.
  warranty: async ({ groupId, siteIds, from, to }) => {
    const [rows, rates] = await Promise.all([
      prisma.invoice.findMany({
        where: { group_id: groupId, site_id: { in: siteIds }, series: 'warranty', ...effectiveIssueDateWhere(from, to) },
        select: {
          id: true, invoice_number: true, series: true, site_id: true, site: { select: { site_name: true } },
          lines: { select: { item_type: true, qty: true, unit_price: true, unit_cost: true, labour_hours: true, labour_outsourced: true } },
        },
      }) as any,
      // Same rate read as the cost-base/unsold tiles: the site's LABOUR_HR default rate.
      prisma.serviceCatalogue.findMany({
        where: { group_id: groupId, site_id: { in: siteIds }, service_code: 'LABOUR_HR' },
        select: { site_id: true, default_labour_rate: true },
      }) as any,
    ]);
    const rateOf = new Map<string, number>(rates.filter((r: any) => r.default_labour_rate != null && Number(r.default_labour_rate) > 0).map((r: any) => [r.site_id, Number(r.default_labour_rate)]));
    let partsCost = 0, centihours = 0, labourValuePennies = 0, linesMissingHours = 0;
    const ratesMissing = new Set<string>();
    const jobs = rows.map((r: any) => {
      const parts = partsCostPennies([r]);
      // Warranty hours land in reworkCentihours (they are SPENT capacity, excluded from charged).
      const cl = chargedLabourCentihours([r]);
      const hours = cl.reworkCentihours;
      partsCost += parts; centihours += hours; linesMissingHours += cl.linesMissingHours;
      const rate = rateOf.get(r.site_id) ?? null;
      if (rate == null && hours > 0) ratesMissing.add(r.site?.site_name ?? '—');
      const value = rate != null ? Math.round((hours / 100) * rate * 100) : 0;
      labourValuePennies += value;
      return { invoiceId: r.id, number: r.invoice_number ?? '', partsCostPennies: parts, centihours: hours, labourValuePennies: value };
    });
    return { count: rows.length, partsCostPennies: partsCost, centihours, labourValuePennies, linesMissingHours, ratesMissing: [...ratesMissing], jobs };
  },
};

// ---------- Month-grained P&L (the profit strip) ----------
// ONE registered compute produces the five P&L figures from a single ledger pass — calendar-month
// grained BY DESIGN (the wage bill is a monthly lump; partial-month labour profit is fiction).
// Line grain: the FROZEN InvoiceLine rows (freeze-at-issue ruling 2026-07-12 — the ledger never
// reads the mutable JobCardItem; the card is the working draft only). Ex-VAT throughout: this is
// a profit statement, VAT is not revenue.
//  Revenue (invoiced, ex-VAT) → − Parts cost → Gross margin → − wages − overheads → Net profit.
//  Plus the operational grain: Hours charged (fixed-service labour_hours + ad-hoc labour qty).
// ---- THE monthly cost-base reads (extracted from pnl VERBATIM — pnl + costBase both call
// these; goldens prove the extraction changed nothing) ----
/** Active SALARIED people only (hourly staff have no hours source until clocking), annual ÷ 12,
 *  scaled by allocation to the visible sites. TODAY'S settings. */
export async function monthlyWageBill(groupId: string, siteIds: string[]): Promise<number> {
  const people = (await prisma.costPerson.findMany({
    where: { group_id: groupId, is_active: true, cost_type: 'salary' },
    select: { amount_pennies: true, allocations: { where: { site_id: { in: siteIds } }, select: { percent: true } } },
  })) as any[];
  return Math.round(people.reduce((a, p2) =>
    a + (p2.amount_pennies / 12) * p2.allocations.reduce((s: number, al: any) => s + Number(al.percent), 0) / 100, 0));
}
/** The Overheads register normalised monthly (annual ÷ 12, weekly × 52 ÷ 12), allocation-scaled.
 *  NO name-matching — the register IS the list; wages live in Headcount, never here. */
export async function monthlyOverheads(groupId: string, siteIds: string[]): Promise<number> {
  const overheads = (await prisma.overhead.findMany({
    where: { group_id: groupId, is_active: true },
    select: { ex_vat_amount_pennies: true, period: true, allocations: { where: { site_id: { in: siteIds } }, select: { percent: true } } },
  })) as any[];
  const monthlyOf = (o: any) => o.period === 'annual' ? o.ex_vat_amount_pennies / 12 : o.period === 'weekly' ? (o.ex_vat_amount_pennies * 52) / 12 : o.ex_vat_amount_pennies;
  return Math.round(overheads.reduce((a, o) =>
    a + monthlyOf(o) * o.allocations.reduce((s: number, al: any) => s + Number(al.percent), 0) / 100, 0));
}

export const MONTH_TILE_COMPUTES: Record<string, (ctx: MonthTileContext) => Promise<unknown>> = {
  // Cost of doing business + break-even hours (pure-labour headline — stable, conservative,
  // stateable in advance; the residual refinement is DISPLAY arithmetic in the popover from
  // pnl numbers). Per-site: site cost base ÷ that site's LABOUR_HR rate, summed — a site with
  // allocated cost but NO rate is FLAGGED, never guessed.
  costBase: async ({ groupId, siteIds, months }) => {
    const sites = (await prisma.site.findMany({ where: { id: { in: siteIds }, group_id: groupId }, orderBy: { created_at: 'asc' }, select: { id: true, site_name: true } })) as any[];
    const rates = (await prisma.serviceCatalogue.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, service_code: 'LABOUR_HR' },
      select: { site_id: true, default_labour_rate: true },
    })) as any[];
    const rateOf = new Map<string, number>(rates.filter((r) => r.default_labour_rate != null && Number(r.default_labour_rate) > 0).map((r) => [r.site_id, Number(r.default_labour_rate)]));
    let wage = 0, over = 0, breakEvenCentihours = 0;
    const perSite: any[] = []; const ratesMissing: string[] = [];
    for (const s2 of sites) {
      const [w, o] = await Promise.all([monthlyWageBill(groupId, [s2.id]), monthlyOverheads(groupId, [s2.id])]);
      const cost = (w + o) * months;
      wage += w * months; over += o * months;
      const rate = rateOf.get(s2.id) ?? null;
      const hoursC = rate ? Math.round((cost / (rate * 100)) * 100) : null; // pennies ÷ (rate£×100 pennies/hr) → hours ×100
      if (cost > 0 && !rate) ratesMissing.push(s2.site_name);
      if (hoursC != null) breakEvenCentihours += hoursC;
      perSite.push({ siteId: s2.id, siteName: s2.site_name, costBasePennies: cost, ratePounds: rate, breakEvenCentihours: hoursC });
    }
    return {
      wageBillPennies: wage, overheadsPennies: over, costBasePennies: wage + over,
      breakEvenCentihours, ratesMissing, perSite, months,
    };
  },
  // Utilisation = charged ÷ SELLABLE (factor-adjusted) over the SAME month window as the pnl.
  // ALL maths live in lib/capacity (getGroupUtilisation: Σcharged ÷ Σsellable, never a mean of
  // ratios) — the tile only renders. Same group-aggregate site scope as the other month tiles.
  utilisation: async ({ groupId, siteIds, from, to }) => getGroupUtilisation(groupId, siteIds, { from, to }),
  // The missing-hours DRILL (presentation read — the metric itself is untouched): which PRODUCTS
  // are behind linesMissingHours (fixed lines whose labour_hours is null — the definition lives
  // in lib/charged-labour). Product-backed lines collapse to distinct products (fix once in the
  // product editor); ad-hoc fixed lines (no catalogue_item_id) are listed separately per invoice
  // — different defect, different fix, never conflated.
  missingHours: async ({ groupId, siteIds, from, to }) => {
    const invs = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, ...effectiveIssueDateWhere(from, to) },
      select: { id: true, invoice_number: true, lines: { select: { item_type: true, labour_hours: true, labour_outsourced: true, catalogue_item_id: true, description: true } } },
    })) as any[];
    const byProduct = new Map<string, number>();
    const adhoc: Array<{ invoiceId: string; number: string; description: string }> = [];
    for (const inv of invs) {
      for (const it of inv.lines ?? []) {
        if (it.item_type !== 'fixed' || it.labour_hours != null || it.labour_outsourced) continue; // outsourced: zero own-hours is CORRECT
        if (it.catalogue_item_id) byProduct.set(it.catalogue_item_id, (byProduct.get(it.catalogue_item_id) ?? 0) + 1);
        else adhoc.push({ invoiceId: inv.id, number: inv.invoice_number ?? '', description: String(it.description ?? '').split('\n')[0] });
      }
    }
    const prods = byProduct.size
      ? ((await prisma.catalogueItem.findMany({ where: { id: { in: [...byProduct.keys()] } }, select: { id: true, name: true } })) as any[])
      : [];
    return {
      products: prods.map((pr) => ({ id: pr.id, name: pr.name, lines: byProduct.get(pr.id) ?? 0 })).sort((a, b) => b.lines - a.lines),
      adhoc,
    };
  },
  pnl: async ({ groupId, siteIds, from, to, months }) => {
    const invoices = await fetchLedgerInvoices({ groupId, siteIds, from, to }); // the ONE ledger read (shared with utilisation)

    // The HONEST chain (ruling 2026-07-10 — replaces the parts/labour margin split, which
    // pretended a decomposition the fixed-price model doesn't make: fixed lines bake labour into
    // the margin): Revenue − Parts cost = Gross margin; Net = margin − wages − overheads.
    let revenueNet = 0;
    for (const inv of invoices) {
      const warranty = inv.series === 'warranty';
      for (const it of inv.lines ?? []) {
        const qty = Number(it.qty);
        const net = computeInvoiceLinePennies(qty, poundsToPennies(Number(it.unit_price)), 0, false).netPennies;
        if (!warranty) revenueNet += net;
      }
    }
    // Parts cost via THE extracted read (lib/charged-labour.partsCostPennies — also the warranty
    // tile's read; comeback drag preserved by construction). Un-costed (null-cost) parts are
    // EXCLUDED there and surfaced HERE so the margin is never silently trusted with unknowns in it.
    const partsCost = partsCostPennies(invoices);
    const uncosted = uncostedParts(invoices);
    // Hours charged — the EXTRACTED numerator (lib/charged-labour), reused verbatim by
    // getUtilisation. Grain + comeback behaviour documented at the helper.
    const { centihours: hoursChargedCentihours, linesMissingHours } = chargedLabourCentihours(invoices);

    // Wage bill + overheads via THE extracted helpers below (also the cost-base tile's reads —
    // one truth, never re-derived).
    const wageBillMonthly = await monthlyWageBill(groupId, siteIds);
    const overheadsMonthly = await monthlyOverheads(groupId, siteIds);

    const grossMargin = revenueNet - partsCost;
    const wageBill = wageBillMonthly * months;
    const operatingCosts = overheadsMonthly * months;
    // Labour contribution: on the fixed-price model the margin IS the labour income (parts are
    // the only other cost) — so contribution = grossMargin − wageBill. SAME fields the net line
    // uses; by construction contribution − operatingCosts === netProfit.
    const labourContribution = grossMargin - wageBill;
    const netProfit = grossMargin - wageBill - operatingCosts; // wages counted ONCE, here
    return { revenueNet, partsCost, grossMargin, hoursChargedCentihours, linesMissingHours, wageBill, labourContribution, operatingCosts, netProfit, months, invoiceCount: invoices.length,
      uncostedPartsLines: uncosted.lines, uncostedPartsRetailPennies: uncosted.retailPennies, uncostedPartsInvoices: uncosted.invoices };
  },
};

export async function computeTiles(ctx: TileContext, monthCtx?: MonthTileContext): Promise<Record<string, unknown>> {
  const entries = await Promise.all([
    ...Object.entries(TILE_COMPUTES).map(async ([key, fn]) => [key, await fn(ctx)] as const),
    ...(monthCtx ? Object.entries(MONTH_TILE_COMPUTES).map(async ([key, fn]) => [key, await fn(monthCtx)] as const) : []),
  ]);
  return Object.fromEntries(entries);
}
