/**
 * File: pages/api/reports/vat-summary.ts
 * The accountant's VAT-on-sales summary as JSON or CSV. ADMIN-only. OUTPUT VAT ONLY (see lib/vat-summary):
 * excludes purchase/input VAT — it is a reconciliation aid, never a complete return. Period from ?preset=
 * (quarter/FY presets) or ?from=&to= (YYYY-MM-DD). ?format=csv streams a spreadsheet.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';
import { resolveRange } from '@/lib/dashboard-periods';
import { getVatSummary } from '@/lib/vat-summary';
import { unclassifiedHeadline, UNCLASSIFIED_ACTION, MARGIN_SECTION_TITLE, marginSectionNote, recordedOutsideLine, totalIncludingMarginLabel } from '@/lib/vat-summary-words';

const money = (p: number) => (p / 100).toFixed(2);
const dateOnly = (iso: string) => iso.slice(0, 10);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;
  if (!groupId) return res.status(400).json({ message: 'No group in scope.' });

  const group = (await prisma.group.findUnique({ where: { id: groupId }, select: { fy_start_month: true, group_name: true, vat_number: true, vat_registered: true , tax_label: true} })) as { fy_start_month: number; group_name: string; vat_number: string | null; vat_registered: boolean; tax_label: string } | null;
  const T = group?.tax_label || 'VAT';
  const range = resolveRange({ preset: req.query.preset as string, from: req.query.from as string, to: req.query.to as string }, group?.fy_start_month ?? 4);
  if (!range) return res.status(400).json({ message: 'Invalid or missing period.' });

  const summary = await getVatSummary(groupId, vis.siteIds, range.from, range.to);
  const periodLabel = `${dateOnly(summary.fromISO)} to ${dateOnly(new Date(range.to.getTime() - 1).toISOString())}`; // inclusive end

  if ((req.query.format as string) === 'csv') {
    const rows: string[] = [];
    rows.push(`${T} on sales for the period — provide to your accountant for your return; excludes purchase/input ${T}`);
    rows.push(`Business,${(group?.group_name ?? '').replace(/,/g, ' ')}`);
    if (group?.vat_number) rows.push(`${T} number,${group.vat_number}`);
    rows.push(`Period,${periodLabel}`);
    rows.push('');
    // REFUSED, VISIBLY — at the top of the file, before any figure a spreadsheet would total.
    if (summary.unclassified.length) {
      rows.push(`"${unclassifiedHeadline(summary.unclassified.length)} ${UNCLASSIFIED_ACTION}"`);
      for (const u of summary.unclassified) rows.push(`Not classified,${u.invoiceNumber},"${u.reason.replace(/"/g, "'")}"`);
      rows.push('');
    }
    // LEFT OUT BY DESIGN, stated before the figures so nobody reads the totals as complete without it.
    if (summary.recordedNotInvoiced.count) {
      rows.push(`"${recordedOutsideLine(summary.recordedNotInvoiced.count)}"`);
      for (const r of summary.recordedNotInvoiced.rows) rows.push(`Recorded outside,${r.registration ?? ''},${r.soldISO.slice(0, 10)}`);
      rows.push('');
    }
    rows.push(`Total sales ex-${T},` + money(summary.netPennies));
    rows.push(`Total output ${T},` + money(summary.vatPennies));
    rows.push('Total gross,' + money(summary.grossPennies));
    rows.push('Invoices,' + summary.invoiceCount);
    rows.push('');
    rows.push(`${T} rate,Net (ex-${T}),${T},Lines`);
    for (const r of summary.byRate) rows.push(`${r.ratePercent}%,${money(r.netPennies)},${money(r.vatPennies)},${r.lineCount}`);
    if (summary.marginScheme.count) {
      rows.push('');
      rows.push(MARGIN_SECTION_TITLE);
      rows.push(`"${marginSectionNote(T)}"`);
      rows.push(`Invoice,Car,Sale,Paid for it,Margin,${T} on margin`);
      for (const r of summary.marginScheme.rows) rows.push(`${r.invoiceNumber},${r.registration ?? ''},${money(r.salePennies)},${money(r.basePennies)},${money(r.marginPennies)},${money(r.vatPennies)}`);
      rows.push(`${T} due on the margin scheme,${money(summary.marginScheme.vatPennies)}`);
      rows.push(`${totalIncludingMarginLabel(T)},${money(summary.totalOutputVatPennies)}`);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vat-on-sales_${dateOnly(summary.fromISO)}_${dateOnly(new Date(range.to.getTime() - 1).toISOString())}.csv"`);
    return res.status(200).send(rows.join('\n'));
  }

  return res.status(200).json({ ...summary, periodLabel, vatRegistered: group?.vat_registered ?? true });
}
