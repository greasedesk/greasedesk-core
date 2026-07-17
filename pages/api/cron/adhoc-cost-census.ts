/**
 * File: pages/api/cron/adhoc-cost-census.ts
 * TEMPORARY, READ-ONLY. Platform-wide census of GENUINELY un-costed ad-hoc parts: non-labour lines
 * with NO catalogue link, POSITIVE retail (a real supplied part, not a discount/warranty credit),
 * and unit_cost = 0. Splits FROZEN InvoiceLine (feeds the P&L) from DRAFT JobCardItem, grouped by
 * tenant + period. Feeds the Option A decision. Changes nothing. CRON_SECRET-guarded. DELETE after.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { effectiveIssueDate } from '@/lib/invoice';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const n = (v: unknown) => (v == null ? 0 : Number(v));
  const groups = (await prisma.group.findMany({ select: { id: true, group_name: true } })) as Array<{ id: string; group_name: string }>;
  const nameById = new Map(groups.map((g) => [g.id, g.group_name]));

  // FROZEN InvoiceLine — the ledger the P&L reads. Genuine un-costed ad-hoc = part/misc, no catalogue
  // link, positive retail, zero cost.
  const invLines = (await prisma.invoiceLine.findMany({
    where: { item_type: { in: ['part', 'misc'] }, catalogue_item_id: null, unit_cost: 0, unit_price: { gt: 0 } },
    select: { qty: true, unit_price: true, description: true, invoice: { select: { group_id: true, date_issued: true, issued_at: true, invoice_number: true } } },
  })) as Array<{ qty: unknown; unit_price: unknown; description: string; invoice: { group_id: string; date_issued: Date | null; issued_at: Date; invoice_number: string | null } }>;

  const frozenByTenantPeriod: Record<string, { tenant: string; period: string; lines: number; retailPounds: number; invoices: Set<string> }> = {};
  let frozenLines = 0, frozenRetail = 0;
  for (const l of invLines) {
    const period = effectiveIssueDate(l.invoice).toISOString().slice(0, 7); // YYYY-MM
    const tenant = nameById.get(l.invoice.group_id) ?? l.invoice.group_id;
    const key = `${tenant}|${period}`;
    const b = (frozenByTenantPeriod[key] ||= { tenant, period, lines: 0, retailPounds: 0, invoices: new Set() });
    b.lines++; b.retailPounds += n(l.qty) * n(l.unit_price); b.invoices.add(l.invoice.invoice_number ?? '?');
    frozenLines++; frozenRetail += n(l.qty) * n(l.unit_price);
  }

  // DRAFT / working JobCardItem — same genuine-ad-hoc filter (not yet frozen; fixed by cataloguing).
  const cardItems = (await prisma.jobCardItem.findMany({
    where: { item_type: { in: ['part', 'misc'] }, catalogue_item_id: null, unit_cost: 0, unit_price: { gt: 0 } },
    select: { job_card: { select: { group_id: true } } },
  })) as Array<{ job_card: { group_id: string } | null }>;
  const draftByTenant: Record<string, number> = {};
  for (const it of cardItems) { const t = nameById.get(it.job_card?.group_id ?? '') ?? (it.job_card?.group_id ?? '?'); draftByTenant[t] = (draftByTenant[t] ?? 0) + 1; }

  return res.status(200).json({
    definition: 'genuine un-costed ad-hoc part = item_type part|misc, catalogue_item_id null, unit_price>0, unit_cost=0 (discounts/warranty excluded)',
    frozenInvoiceLines: {
      total: frozenLines, retailPounds: Number(frozenRetail.toFixed(2)),
      byTenantPeriod: Object.values(frozenByTenantPeriod)
        .map((b) => ({ tenant: b.tenant, period: b.period, lines: b.lines, retailPounds: Number(b.retailPounds.toFixed(2)), invoices: [...b.invoices].sort() }))
        .sort((a, b) => (a.tenant + a.period < b.tenant + b.period ? -1 : 1)),
    },
    draftJobCardItems: { total: cardItems.length, byTenant: draftByTenant },
  });
}
