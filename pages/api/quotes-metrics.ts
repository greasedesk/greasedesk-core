/**
 * File: pages/api/quotes-metrics.ts
 * GET ?preset=… | ?from=&to=  → the quotes summary panel's figures for the selected period, plus
 * the AS-OF-NOW awaiting stock, over the caller's visible sites.
 *
 * Two different questions, answered by two different readers ON PURPOSE:
 *   • Awaiting is a STOCK — what is outstanding right now — and comes from listQuotes unchanged.
 *   • Everything else is a FLOW within the period and comes from lib/quotes-metrics, which must not
 *     read listQuotes (see that file's header: one row per card, closed cards excluded, both fatal
 *     for a historic total).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { resolveRange } from '@/lib/dashboard-periods';
import { computeQuotesMetrics } from '@/lib/quotes-metrics';
import { listQuotes } from '@/lib/quotes-list';
import { getTenantDataStart, precedesData } from '@/lib/tenant-data-start';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.siteIds.length) return res.status(403).json({ message: 'You do not have permission to view quotes.' });

  const grp = (await prisma.group.findUnique({ where: { id: user.group_id }, select: { fy_start_month: true } })) as any;
  const range = resolveRange(
    { preset: req.query.preset ? String(req.query.preset) : undefined, from: req.query.from ? String(req.query.from) : undefined, to: req.query.to ? String(req.query.to) : undefined },
    grp?.fy_start_month ?? 4,
  );
  if (!range) return res.status(400).json({ message: 'Pick a period preset or a valid date range.' });

  let siteIds = vis.siteIds;
  if (req.query.site) {
    const siteId = String(req.query.site);
    if (!canAccessSite(vis, siteId)) return res.status(403).json({ message: 'You don’t have access to that site.' });
    siteIds = [siteId];
  }

  // AWAITING IS ALWAYS COMPUTED — it is a stock, and a period that predates the tenant does not
  // make today's outstanding quotes unknown. Only the PERIOD figures take the beforeData path.
  const awaiting = (await listQuotes({ groupId: user.group_id as string, siteIds, filter: 'awaiting' }));
  const awaitingPennies = awaiting.reduce((s, r) => s + r.grossPennies, 0);
  const awaitingVerbalCount = awaiting.filter((r) => r.verbal).length;

  const dataStart = await getTenantDataStart(user.group_id as string);
  const beforeData = precedesData(range.to, dataStart);
  if (beforeData) {
    return res.status(200).json({
      beforeData: true, dataStart: dataStart ? dataStart.toISOString() : null,
      from: range.from.toISOString(), to: range.to.toISOString(),
      awaitingPennies, awaitingCount: awaiting.length, awaitingVerbalCount,
      metrics: null,
    });
  }

  const metrics = await computeQuotesMetrics({ groupId: user.group_id as string, siteIds, from: range.from, to: range.to });
  return res.status(200).json({
    beforeData: false, dataStart: dataStart ? dataStart.toISOString() : null,
    from: range.from.toISOString(), to: range.to.toISOString(),
    awaitingPennies, awaitingCount: awaiting.length, awaitingVerbalCount,
    metrics,
  });
}
