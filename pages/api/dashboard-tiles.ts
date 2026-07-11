/**
 * File: pages/api/dashboard-tiles.ts
 * GET ?preset=this_month | ?from=yyyy-mm-dd&to=yyyy-mm-dd → all registered tiles computed over the
 * caller's visible sites (admin = all group sites, manager = assigned; STANDARD 403s — the
 * dashboard's money surface is manager/admin, mirroring the landing rule). Period presets respect
 * the tenant's fiscal-year start. Tiles are computed by the ONE server registry (lib/dashboard-tiles).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { resolveRange, resolveMonthSpan } from '@/lib/dashboard-periods';
import { computeTiles } from '@/lib/dashboard-tiles';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vis = await getVisibility(user.id as string);
  if (!(vis.isAdmin || vis.role === 'SITE_MANAGER') || vis.siteIds.length === 0) {
    return res.status(403).json({ message: 'You do not have permission to view the dashboard.' });
  }

  const grp = (await prisma.group.findUnique({ where: { id: user.group_id }, select: { fy_start_month: true } })) as any;
  const range = resolveRange(
    { preset: req.query.preset ? String(req.query.preset) : undefined, from: req.query.from ? String(req.query.from) : undefined, to: req.query.to ? String(req.query.to) : undefined },
    grp?.fy_start_month ?? 4,
  );
  if (!range) return res.status(400).json({ message: 'Pick a period preset or a valid date range.' });

  // The P&L strip's SEPARATE month-grained span (whole months only — defaults to this month).
  const monthSpan = resolveMonthSpan(
    { mpreset: req.query.mpreset ? String(req.query.mpreset) : (req.query.mfrom ? undefined : 'this_month'), mfrom: req.query.mfrom ? String(req.query.mfrom) : undefined, mto: req.query.mto ? String(req.query.mto) : undefined },
    grp?.fy_start_month ?? 4,
  );
  if (!monthSpan) return res.status(400).json({ message: 'Pick a whole-month period for the profit tiles.' });

  // Optional single-site scope — SERVER-enforced: only a site the caller can access ever
  // narrows the seam (the selector is decoration; this is the control). Default = all visible.
  let siteIds = vis.siteIds;
  if (req.query.site) {
    const siteId = String(req.query.site);
    if (!canAccessSite(vis, siteId)) return res.status(403).json({ message: 'You don’t have access to that site.' });
    siteIds = [siteId];
  }
  const base = { groupId: user.group_id as string, siteIds };
  const tiles = await computeTiles({ ...base, from: range.from, to: range.to }, { ...base, from: monthSpan.from, to: monthSpan.to, months: monthSpan.months });
  return res.status(200).json({ tiles, from: range.from.toISOString(), to: range.to.toISOString(), monthFrom: monthSpan.from.toISOString(), monthTo: monthSpan.to.toISOString() });
}
