/**
 * File: pages/api/cron/june-reconcile.ts
 * TEMPORARY, READ-ONLY. Proves — on the SERVED build, through the DEPLOYED P&L readers — that after
 * the unit_cost-nullable change, TMBS June parts cost is still £3,612.88 (frozen values unchanged),
 * and reports the platform-wide un-costed exposure the P&L now surfaces. CRON_SECRET-guarded. DELETE after.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { TMBS_GROUP_ID } from '@/lib/superadmin';
import { fetchLedgerInvoices, partsCostPennies, uncostedParts } from '@/lib/charged-labour';
import { prisma } from '@/lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const sites = (await prisma.site.findMany({ where: { group_id: TMBS_GROUP_ID }, select: { id: true } })) as Array<{ id: string }>;
  const siteIds = sites.map((s) => s.id);
  const month = async (fromISO: string, toISO: string) => {
    const invoices = await fetchLedgerInvoices({ groupId: TMBS_GROUP_ID, siteIds, from: new Date(fromISO), to: new Date(toISO) });
    const partsCost = partsCostPennies(invoices);
    const exposure = uncostedParts(invoices);
    return { invoices: invoices.length, partsCostPounds: (partsCost / 100).toFixed(2), uncostedParts: { lines: exposure.lines, retailPounds: (exposure.retailPennies / 100).toFixed(2), invoices: exposure.invoices } };
  };
  return res.status(200).json({
    tmbsJune: await month('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'), // partsCost MUST be 3612.88, uncosted 0
    tmbsJuly: await month('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'), // exposure should surface the 6 lines
  });
}
