/**
 * File: pages/api/cron/dash-goldens.ts
 * TEMPORARY, READ-ONLY. Runs the DEPLOYED month-tile computes (pnl + utilisation) for TMBS over June
 * (closed) and July (in-progress) so the goldens can be asserted on the served build: June must be
 * byte-identical; July must show the to-date utilisation + remaining capacity. CRON_SECRET. DELETE after.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { TMBS_GROUP_ID } from '@/lib/superadmin';
import { MONTH_TILE_COMPUTES } from '@/lib/dashboard-tiles';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const sites = (await prisma.site.findMany({ where: { group_id: TMBS_GROUP_ID }, select: { id: true } })) as Array<{ id: string }>;
  const siteIds = sites.map((s) => s.id);
  const now = new Date();
  const money = (p: number) => (p / 100).toFixed(2);

  const run = async (fromISO: string, toISO: string) => {
    const ctx = { groupId: TMBS_GROUP_ID, siteIds, from: new Date(fromISO), to: new Date(toISO), months: 1, now };
    const pnl: any = await MONTH_TILE_COMPUTES.pnl(ctx);
    const util: any = await MONTH_TILE_COMPUTES.utilisation(ctx);
    const cb: any = await MONTH_TILE_COMPUTES.costBase(ctx);
    const rw = util.rework ?? 0;
    const unsold = Math.max(0, util.available - util.charged - rw);
    return {
      inProgress: !!util.inProgress,
      revenueNet: money(pnl.revenueNet),
      partsCost: money(pnl.partsCost),
      netProfit: money(pnl.netProfit),
      hoursCharged: (pnl.hoursChargedCentihours / 100).toFixed(2),
      utilisationPct: util.ratio == null ? null : (util.ratio * 100).toFixed(1),
      chargedH: util.charged.toFixed(2),
      sellableH: util.available.toFixed(2),
      unsoldH: unsold.toFixed(2),
      breakEvenH: cb.breakEvenCentihours != null ? (cb.breakEvenCentihours / 100).toFixed(2) : null,
      // in-progress extras:
      remainingSellableH: util.remainingSellable != null ? util.remainingSellable.toFixed(2) : null,
      remainingValue: util.remainingValuePennies != null ? money(util.remainingValuePennies) : null,
      bookedH: util.bookedHoursRemaining ?? null,
    };
  };

  return res.status(200).json({
    june: await run('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'),
    july: await run('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  });
}
