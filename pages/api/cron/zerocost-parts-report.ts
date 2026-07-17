/**
 * File: pages/api/cron/zerocost-parts-report.ts
 * TEMPORARY, READ-ONLY. Lists TMBS ISSUED invoices whose FROZEN InvoiceLines include a £0-cost
 * non-labour (part/misc) line — i.e. ad-hoc parts that were silently null-costed before the
 * 2026-07-17 ad-hoc cost fix. Feeds the "report which invoices, then decide" decision; it changes
 * nothing. CRON_SECRET-guarded. DELETE after the list is captured.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { TMBS_GROUP_ID } from '@/lib/superadmin';
import { effectiveIssueDate, effectiveIssueDateWhere } from '@/lib/invoice';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const invoices = (await prisma.invoice.findMany({
    where: { group_id: TMBS_GROUP_ID, invoice_number: { not: null } }, // issued (has a number) — draft has none
    select: {
      invoice_number: true, date_issued: true, issued_at: true, status: true,
      lines: { select: { item_type: true, description: true, qty: true, unit_price: true, unit_cost: true } },
    },
  })) as Array<{
    invoice_number: string | null; date_issued: Date | null; issued_at: Date; status: string;
    lines: Array<{ item_type: string; description: string | null; qty: unknown; unit_price: unknown; unit_cost: unknown }>;
  }>;

  const n = (v: unknown) => (v == null ? 0 : Number(v));
  const affected: any[] = [];
  let totalPartsLines = 0, totalZeroCostLines = 0, zeroCostRetailPounds = 0;

  for (const inv of invoices) {
    const partsLines = inv.lines.filter((l) => l.item_type === 'part' || l.item_type === 'misc');
    const zeros = partsLines.filter((l) => n(l.unit_cost) === 0);
    totalPartsLines += partsLines.length;
    totalZeroCostLines += zeros.length;
    if (zeros.length === 0) continue;
    const retail = zeros.reduce((s, l) => s + n(l.qty) * n(l.unit_price), 0);
    zeroCostRetailPounds += retail;
    affected.push({
      invoice: inv.invoice_number,
      issued: effectiveIssueDate(inv).toISOString().slice(0, 10),
      status: inv.status,
      partsLines: partsLines.length,
      zeroCostLines: zeros.length,
      zeroCostRetailPounds: Number(retail.toFixed(2)),
      lines: zeros.map((l) => ({ description: (l.description ?? '').slice(0, 60), qty: n(l.qty), unitPriceRetail: n(l.unit_price) })),
    });
  }

  // June reconciliation: the frozen parts-cost the P&L reads for 2026-06. My forward fix writes only
  // the DRAFT JobCardItem, never InvoiceLine, so this must still be £3,612.88 (proof it doesn't move).
  const juneInvoices = (await prisma.invoice.findMany({
    where: { group_id: TMBS_GROUP_ID, ...effectiveIssueDateWhere(new Date('2026-06-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z')) },
    select: { lines: { select: { item_type: true, qty: true, unit_cost: true } } },
  })) as Array<{ lines: Array<{ item_type: string; qty: unknown; unit_cost: unknown }> }>;
  let junePartsCost = 0;
  for (const inv of juneInvoices) for (const l of inv.lines) if (l.item_type !== 'labour') junePartsCost += n(l.qty) * n(l.unit_cost);

  // Split: a genuinely mis-costed ad-hoc part has POSITIVE retail; negative/zero-retail zero-cost
  // lines are discounts / warranty goodwill and CORRECTLY carry no cost.
  const genuine = affected.flatMap((a) => a.lines.filter((l: any) => l.unitPriceRetail > 0).map((l: any) => ({ invoice: a.invoice, issued: a.issued, ...l })));

  affected.sort((a, b) => (a.issued < b.issued ? -1 : 1));
  return res.status(200).json({
    juneReconcile: { partsCostPounds: Number(junePartsCost.toFixed(2)), invoices: juneInvoices.length },
    genuineMiscostedAdHocParts: { lines: genuine.length, retailAtZeroCostPounds: Number(genuine.reduce((s, l) => s + l.qty * l.unitPriceRetail, 0).toFixed(2)), detail: genuine },
    scope: 'TMBS issued invoices (frozen InvoiceLine)',
    summary: {
      invoicesAffected: affected.length,
      totalPartsLines, totalZeroCostLines,
      zeroCostRetailPounds: Number(zeroCostRetailPounds.toFixed(2)), // retail value of the mis-costed parts
    },
    invoices: affected,
  });
}
