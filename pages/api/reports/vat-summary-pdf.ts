/**
 * File: pages/api/reports/vat-summary-pdf.ts
 * The VAT-on-sales summary as an A4 PDF. ADMIN-only. OUTPUT VAT ONLY — the PDF prints the disclaimer.
 * Period from ?preset= or ?from=&to=.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { resolveRange } from '@/lib/dashboard-periods';
import { getVatSummary } from '@/lib/vat-summary';
import { renderVatSummaryPdf } from '@/lib/vat-summary-pdf';
import { displayCurrency } from '@/lib/display-currency';

const dateOnly = (iso: string) => iso.slice(0, 10);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;
  if (!groupId) return res.status(400).json({ message: 'No group in scope.' });

  const group = (await prisma.group.findUnique({ where: { id: groupId }, select: { fy_start_month: true, group_name: true, vat_number: true } })) as { fy_start_month: number; group_name: string; vat_number: string | null } | null;
  const range = resolveRange({ preset: req.query.preset as string, from: req.query.from as string, to: req.query.to as string }, group?.fy_start_month ?? 4);
  if (!range) return res.status(400).json({ message: 'Invalid or missing period.' });

  const summary = await getVatSummary(groupId, vis.siteIds, range.from, range.to);
  const periodLabel = `${dateOnly(summary.fromISO)} to ${dateOnly(new Date(range.to.getTime() - 1).toISOString())}`;
  const { currency, locale } = await displayCurrency(vis.primarySiteId);
  const pdf = await renderVatSummaryPdf({ ...summary, businessName: group?.group_name ?? 'Your business', vatNumber: group?.vat_number ?? null, periodLabel, currency, locale });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="vat-on-sales_${dateOnly(summary.fromISO)}_${dateOnly(new Date(range.to.getTime() - 1).toISOString())}.pdf"`);
  return res.status(200).send(pdf);
}
