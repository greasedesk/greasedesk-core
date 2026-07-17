/**
 * File: pages/api/cron/parts-cost-audit.ts — TEMPORARY, READ-ONLY (parts-cost report). DELETE after.
 * CRON_SECRET-guarded. No writes. Reports zero-cost parts lines (live estimates + frozen invoices)
 * and reconciles TMBS's June parts-cost so we can characterise the ad-hoc-null-cost effect before fixing.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { TMBS_GROUP_ID } from '@/lib/superadmin';
import { effectiveIssueDateWhere } from '@/lib/invoice';

const PARTS = ['part', 'misc'] as const; // "Parts & materials" section; fixed has its own cost path

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  // Platform-wide zero-cost counts (parts only).
  const jciTotal = await prisma.jobCardItem.count({ where: { item_type: { in: PARTS as any } } });
  const jciZero = await prisma.jobCardItem.count({ where: { item_type: { in: PARTS as any }, unit_cost: 0 } });
  const ilTotal = await prisma.invoiceLine.count({ where: { item_type: { in: PARTS as any } } });
  const ilZero = await prisma.invoiceLine.count({ where: { item_type: { in: PARTS as any }, unit_cost: 0 } });

  // TMBS June (effective issue date) reconciliation — READ ONLY.
  const juneFrom = new Date(Date.parse('2026-06-01T00:00:00.000Z'));
  const juneTo = new Date(Date.parse('2026-07-01T00:00:00.000Z'));
  const tmbsJune = (await prisma.invoice.findMany({
    where: { group_id: TMBS_GROUP_ID, ...effectiveIssueDateWhere(juneFrom, juneTo) },
    select: { series: true, lines: { select: { item_type: true, qty: true, unit_cost: true } } },
  })) as Array<{ series: string; lines: Array<{ item_type: string | null; qty: unknown; unit_cost: unknown }> }>;

  let junePartsCostPennies = 0, junePartsLines = 0, junePartsLinesZeroCost = 0;
  for (const inv of tmbsJune) {
    for (const l of inv.lines) {
      if (l.item_type === 'labour') continue; // non-labour = the P&L's "parts cost"
      const cost = Number(l.unit_cost ?? 0);
      junePartsCostPennies += Math.round(Number(l.qty) * Math.round(cost * 100));
      if (l.item_type === 'part' || l.item_type === 'misc') { junePartsLines += 1; if (cost === 0) junePartsLinesZeroCost += 1; }
    }
  }

  return res.status(200).json({
    liveEstimateParts: { total: jciTotal, zeroCost: jciZero },
    frozenInvoiceParts: { total: ilTotal, zeroCost: ilZero },
    tmbsJune: {
      invoices: tmbsJune.length,
      partsCostPounds: (junePartsCostPennies / 100).toFixed(2),
      partsLines: junePartsLines,
      partsLinesZeroCost: junePartsLinesZeroCost,
    },
  });
}
