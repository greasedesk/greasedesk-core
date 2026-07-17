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
import { effectiveIssueDate } from '@/lib/invoice';

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

  affected.sort((a, b) => (a.issued < b.issued ? -1 : 1));
  return res.status(200).json({
    scope: 'TMBS issued invoices (frozen InvoiceLine)',
    summary: {
      invoicesAffected: affected.length,
      totalPartsLines, totalZeroCostLines,
      zeroCostRetailPounds: Number(zeroCostRetailPounds.toFixed(2)), // retail value of the mis-costed parts
    },
    invoices: affected,
  });
}
