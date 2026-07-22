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
import { periodImportState, NO_IMPORT, type ImportPeriod } from '@/lib/import-period';
import { listWhere } from '@/lib/invoice-list-filters';
import { invoiceTotals, effectivePaidDate, effectiveIssueDate, effectiveIssueDateWhere } from '@/lib/invoice';
import { fetchLedgerInvoices, chargedLabourCentihours, lineLabourCentihours, partsCostPennies, uncostedParts, labourGrossMargin } from '@/lib/charged-labour';
import { getGroupUtilisation, getDailyCapacity, dayKey } from '@/lib/capacity';
import { wipCardsWhere, wipCardValuePennies, WIP_AGE_DAYS } from '@/lib/wip';

// `now` reaches EVERY compute (point-in-time cash tiles age their rows against it; month tiles use
// it for the in-progress-month to-date window). Passed in — never `new Date()` inside a compute —
// so a tile's output is a pure function of its context (goldens are reproducible).
export type TileContext = { groupId: string; siteIds: string[]; from: Date; to: Date; now: Date };
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
  // Routed through lib/invoice-list-filters rather than repeating the predicate: this tile links to
  // the Invoices list filtered 'unpaid', and a duplicated filter drifted once already — the imported
  // exclusion was added to the list and NOT here, so an unpaid imported invoice would have been
  // chased from the tile while being correctly absent from the list it opens.
  debtors: async ({ groupId, siteIds }) => {
    const { where: unpaidWhere } = listWhere('unpaid', null);
    const rows = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, ...unpaidWhere },
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

  // Work in progress, NOT invoiced: a point-in-time snapshot of unbilled work (period-independent,
  // like Debtors). Filter + per-card ex-VAT value come from THE shared chokepoint (lib/wip) that the
  // list this tile links to also reads — so the tile total and the list total can never drift. A
  // comeback counts as open work but adds £0. Ageing: cards open (created) > WIP_AGE_DAYS.
  wip: async ({ siteIds, now }) => {
    const cards = (await prisma.jobCard.findMany({
      where: wipCardsWhere(siteIds),
      select: { is_comeback: true, labour_bill_numeric: true, parts_bill_numeric: true, created_at: true },
    })) as any[];
    const cutoff = new Date(now.getTime() - WIP_AGE_DAYS * 86_400_000);
    let exVatPennies = 0, agedCount = 0;
    for (const c of cards) {
      exVatPennies += wipCardValuePennies(c);
      if (c.created_at < cutoff) agedCount += 1;
    }
    return { count: cards.length, exVatPennies, agedCount, ageDays: WIP_AGE_DAYS };
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
  // Utilisation = charged ÷ SELLABLE (factor-adjusted). ALL maths in lib/capacity (getGroupUtilisation:
  // Σcharged ÷ Σsellable, never a mean of ratios). IN-PROGRESS SINGLE MONTH (from ≤ now < to, months=1):
  // both sides use the SAME to-date window [from, start-of-tomorrow) — sold-to-date ÷ capacity-to-date,
  // fixing the full-month-denominator mismatch. Capacity-to-date is EXACT (day-by-day rostered days,
  // bank holidays, booked leave — never a linear fraction). Also returns REMAINING sellable for the rest
  // of the month, valued at each site's LABOUR_HR rate, plus diary hours already booked in that window
  // (a DIFFERENT measure — bay occupancy, not sellable labour — surfaced side-by-side, never subtracted).
  // CLOSED month (to ≤ now) or multi-month span → the window is [from, to] unchanged → byte-identical.
  utilisation: async ({ groupId, siteIds, from, to, months, now }) => {
    // Utilisation divides committed charged hours by the WHOLE period's sellable capacity, so a
    // part-imported month reports a near-zero ratio that means nothing (May: 0.3%). Withheld.
    const importedU = await periodImportState(groupId, siteIds, from, to);
    const inProgress = months === 1 && from.getTime() <= now.getTime() && now.getTime() < to.getTime();
    const startOfTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const end = inProgress && startOfTomorrow.getTime() < to.getTime() ? startOfTomorrow : to;
    const u = await getGroupUtilisation(groupId, siteIds, { from, to: end });
    // A part-imported period divides committed charged hours by the WHOLE period's capacity, so the
    // ratio is meaningless (May on 1 of 42: 0.3%). Withhold it and say why; keep the raw hours,
    // which are true as far as they go. `ratio` ABSENT is the signal, matching honest-null.
    if (importedU.suppressDerived) {
      const { ratio, ...rest } = u as any;
      return { ...rest, imported: importedU, suppressed: true };
    }
    if (!inProgress) return { ...u, imported: importedU }; // closed month / multi-month → unchanged (goldens byte-identical)

    // Remaining sellable capacity for [end, to) — the rest of the month — valued at the site rate.
    const rem = end.getTime() < to.getTime() ? await getGroupUtilisation(groupId, siteIds, { from: end, to }) : null;
    const rates = (await prisma.serviceCatalogue.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, service_code: 'LABOUR_HR' },
      select: { site_id: true, default_labour_rate: true },
    })) as any[];
    const rateOf = new Map<string, number>(rates.filter((r) => r.default_labour_rate != null && Number(r.default_labour_rate) > 0).map((r) => [r.site_id, Number(r.default_labour_rate)]));
    let remainingValuePennies = 0; const remainingNoRate: string[] = [];
    for (const s of rem?.perSite ?? []) {
      if (s.available <= 0) continue;
      const rate = rateOf.get(s.siteId);
      if (rate == null) remainingNoRate.push(s.siteName);
      else remainingValuePennies += Math.round(s.available * rate * 100);
    }
    // Diary hours ALREADY BOOKED in the remaining window (a live booking, not a cancelled/declined one).
    const booked = (await prisma.jobCard.findMany({
      where: { site_id: { in: siteIds }, resource_id: { not: null }, status: { notIn: ['cancelled', 'declined'] as any }, start_at: { gte: end, lt: to } },
      select: { booking_duration_minutes: true, start_at: true, end_at: true },
    })) as any[];
    const bookedMinutes = booked.reduce((a, b) => a + (b.booking_duration_minutes ?? (b.start_at && b.end_at ? Math.round(((b.end_at as Date).getTime() - (b.start_at as Date).getTime()) / 60000) : 0)), 0);

    return {
      ...u,
      imported: importedU,
      inProgress: true,
      periodFromISO: from.toISOString(),
      periodToInclusiveISO: now.toISOString(), // the elapsed period is [from, end-of-today]
      remainingSellable: rem?.available ?? 0,
      remainingValuePennies,
      remainingNoRate,
      bookedHoursRemaining: Math.round((bookedMinutes / 60) * 100) / 100,
    };
  },
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
    // Revenue − Parts cost = Gross margin via THE extracted read (lib/charged-labour.labourGrossMargin
    // — now ALSO the effective-hourly-rate tile's numerator; goldens prove the extraction is inert).
    // GENUINELY un-costed parts (no cost recorded) bring in revenue with no cost offset, so they
    // INFLATE gross margin — surfaced HERE (uncostedParts), never silently trusted at 100% margin.
    const { revenueNet, partsCost, grossMargin } = labourGrossMargin(invoices);
    const uncosted = uncostedParts(invoices);
    // Hours charged — the EXTRACTED numerator (lib/charged-labour), reused verbatim by
    // getUtilisation. Grain + comeback behaviour documented at the helper.
    const { centihours: hoursChargedCentihours, linesMissingHours } = chargedLabourCentihours(invoices);

    // Wage bill + overheads via THE extracted helpers below (also the cost-base tile's reads —
    // one truth, never re-derived).
    const wageBillMonthly = await monthlyWageBill(groupId, siteIds);
    const overheadsMonthly = await monthlyOverheads(groupId, siteIds);

    // IMPORT SUPPRESSION. A partially imported period charges the FULL month's wages and overheads
    // against whatever fraction of revenue has been committed, so netProfit/labourContribution are
    // not approximate — they are wrong (May 2026 on 1 of 42 read −£7,077.61). They are OMITTED
    // server-side, not blanked client-side, so the wrong figure never leaves this process.
    // revenueNet, partsCost and grossMargin are true as far as they go and are kept.
    const imported = await periodImportState(groupId, siteIds, from, to);

    const wageBill = wageBillMonthly * months;
    const operatingCosts = overheadsMonthly * months;
    // Labour contribution: on the fixed-price model the margin IS the labour income (parts are
    // the only other cost) — so contribution = grossMargin − wageBill. SAME fields the net line
    // uses; by construction contribution − operatingCosts === netProfit.
    const labourContribution = grossMargin - wageBill;
    const netProfit = grossMargin - wageBill - operatingCosts; // wages counted ONCE, here
    const base = { revenueNet, partsCost, grossMargin, hoursChargedCentihours, linesMissingHours, months, invoiceCount: invoices.length,
      uncostedPartsLines: uncosted.lines, uncostedPartsRetailPennies: uncosted.retailPennies, uncostedPartsInvoices: uncosted.invoices,
      imported };
    if (imported.suppressDerived) return base; // wageBill/labourContribution/operatingCosts/netProfit WITHHELD
    return { ...base, wageBill, labourContribution, operatingCosts, netProfit };
  },

  // Capacity — THE headline metric: a month-long burn-up of three CUMULATIVE labour-hour lines, plus
  // the realised-rate + potential-vs-actual figures. NO new financial calculation — every input is a
  // chokepoint read:
  //   1) Capacity pace (target) = getDailyCapacity — sellable hours accruing per working day, flat on
  //      weekends/BH/closed days, reaching the utilisation tile's sellable total on the last working day.
  //   2) Committed = labour hours on WIP cards (THE wip chokepoint: accepted/in_progress, no invoice),
  //      dated by DIARY date (start_at ?? created_at). Hours TAKEN ON, not worked — there is no clocking.
  //   3) Billed = charged labour hours (lib/charged-labour, warranty excluded), dated by invoice date.
  // Figures below: headline rate (LABOUR_HR) vs realised (charged×rate ÷ sellable); potential
  // (sellable×rate) vs actual (charged×rate). All valued PER SITE so mixed-rate groups stay honest.
  capacity: async ({ groupId, siteIds, from, to, months, now }) => {
    // To-date window for the ACTUALS (charged / effective): to-date for a live single month, else full.
    const inProgress = months === 1 && from.getTime() <= now.getTime() && now.getTime() < to.getTime();
    const startOfTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const end = inProgress && startOfTomorrow.getTime() < to.getTime() ? startOfTomorrow : to;

    // 1) Capacity pace — FULL-month daily accrual (the target reaches full sellable on the last working day).
    const daily = await getDailyCapacity(groupId, siteIds, { from, to });
    const sellableHours = daily.total; // === utilisation's sellable by construction

    // Headline labour rate(s) — LABOUR_HR (same read as cost-base / warranty).
    const rates = (await prisma.serviceCatalogue.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, service_code: 'LABOUR_HR' },
      select: { site_id: true, default_labour_rate: true },
    })) as any[];
    const rateBySite = new Map<string, number>(rates.filter((r) => r.default_labour_rate != null && Number(r.default_labour_rate) > 0).map((r) => [r.site_id, Number(r.default_labour_rate)]));
    const distinct = [...new Set(rateBySite.values())];
    const headlineRatePennies = distinct.length === 1 ? Math.round(distinct[0] * 100) : null;

    // 2) Committed — WIP cards' labour hours (THE wip chokepoint), dated by diary date, this month only.
    const wipCards = (await prisma.jobCard.findMany({
      where: wipCardsWhere(siteIds),
      select: { start_at: true, created_at: true, items: { select: { item_type: true, qty: true, labour_hours: true, labour_outsourced: true } } },
    })) as any[];
    const committedByDay = new Map<string, number>(); // dayKey → centihours
    let committedTotalCenti = 0;
    for (const c of wipCards) {
      const d: Date = c.start_at ?? c.created_at; // when capacity was consumed (diary date; created as fallback)
      if (!(d >= from && d < to)) continue;
      let centi = 0;
      for (const it of c.items ?? []) centi += lineLabourCentihours(it).centihours;
      if (centi === 0) continue;
      const k = dayKey(d);
      committedByDay.set(k, (committedByDay.get(k) ?? 0) + centi);
      committedTotalCenti += centi;
    }

    // 3) Billed — charged labour hours dated by effective issue date; total === the "Hours charged" tile.
    const invs = (await prisma.invoice.findMany({
      where: { group_id: groupId, site_id: { in: siteIds }, ...effectiveIssueDateWhere(from, to) },
      select: { date_issued: true, issued_at: true, series: true, lines: { select: { item_type: true, qty: true, labour_hours: true, labour_outsourced: true } } },
    })) as any[];
    const billedByDay = new Map<string, number>();
    let billedTotalCenti = 0;
    for (const inv of invs) {
      const centi = chargedLabourCentihours([{ series: inv.series, lines: inv.lines }]).centihours; // billable only (rework excluded)
      if (centi === 0) continue;
      const k = dayKey(effectiveIssueDate(inv));
      billedByDay.set(k, (billedByDay.get(k) ?? 0) + centi);
      billedTotalCenti += centi;
    }

    // Three cumulative series over the full month's day list. Committed/Billed carry NO future data,
    // so on a live month they naturally stop at today — the client draws them only to daysElapsed.
    let cc = 0, bb = 0;
    const series = daily.days.map((pt) => {
      cc += committedByDay.get(pt.dayKey) ?? 0;
      bb += billedByDay.get(pt.dayKey) ?? 0;
      return { day: Number(pt.dayKey.slice(8, 10)), capacity: pt.cumulativeSellable, committed: Math.round(cc) / 100, billed: Math.round(bb) / 100 };
    });

    // To-date charged (for realised rate + actual revenue) via the utilisation window, valued per site.
    const windowUtil = await getGroupUtilisation(groupId, siteIds, { from, to: end });
    const chargedHours = windowUtil.charged;
    let actualPennies = 0; const ratesMissing: string[] = [];
    for (const s of windowUtil.perSite) {
      const rate = rateBySite.get(s.siteId);
      if (rate == null) { if (s.available > 0) ratesMissing.push(s.siteName); continue; }
      actualPennies += Math.round(s.charged * rate * 100);
    }
    // Potential = FULL-month sellable × rate, per site.
    let potentialPennies = 0;
    for (const s of daily.perSite) { const rate = rateBySite.get(s.siteId); if (rate != null) potentialPennies += Math.round(s.sellable * rate * 100); }

    const imported = await periodImportState(groupId, siteIds, from, to);
    const withheld = imported.suppressDerived === true;
    const sellableToDate = windowUtil.available; // effective divides by the to-date sellable (== full for a closed month)
    const effectiveRatePennies = (!withheld && actualPennies > 0 && sellableToDate > 0) ? Math.round(actualPennies / sellableToDate) : null;

    return {
      series, sellableHours, chargedHours,
      headlineRatePennies, headlineRateMixed: distinct.length > 1,
      potentialPennies: withheld ? null : potentialPennies,
      actualPennies: withheld ? null : actualPennies,
      effectiveRatePennies,
      committedTotalCentihours: committedTotalCenti,
      billedTotalCentihours: billedTotalCenti,
      ratesMissing, imported, months,
    };
  },
};

export async function computeTiles(ctx: TileContext, monthCtx?: MonthTileContext): Promise<Record<string, unknown>> {
  const entries = await Promise.all([
    ...Object.entries(TILE_COMPUTES).map(async ([key, fn]) => [key, await fn(ctx)] as const),
    ...(monthCtx ? Object.entries(MONTH_TILE_COMPUTES).map(async ([key, fn]) => [key, await fn(monthCtx)] as const) : []),
  ]);
  return Object.fromEntries(entries);
}
