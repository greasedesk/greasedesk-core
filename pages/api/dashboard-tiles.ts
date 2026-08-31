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
import { clipSpanToAnchor } from '@/lib/reporting-anchor';
import { forwardCosts } from '@/lib/dashboard-tiles';
import { thresholdsFromGroup } from '@/lib/utilisation-light';

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

  const grp = (await prisma.group.findUnique({
    where: { id: user.group_id },
    select: { fy_start_month: true, util_red_below: true, util_amber_below: true, reporting_start_date: true },
  })) as any;
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
  const now = new Date();
  // ── ONE ANCHOR, APPLIED ONCE, BEFORE ANYTHING IS COMPUTED ────────────────────────────────────
  // Clipping used to be opt-in per tile: three computes clipped to the earliest record and four did
  // not, so net profit measured TWELVE months of payroll against FIVE months of trading and sat
  // beside a five-month cost base. Both figures were defensible; the pair was not.
  //
  // Doing it HERE makes clipping opt-OUT. Every compute receives a window already inside the
  // tenant's reporting period, a new tile is clipped by default, and a tile that should not be has
  // to say so in writing. `months` is recomputed with the window — cost is a monthly rate × months,
  // and moving `from` alone would bill a year of payroll against five months.
  const anchor = grp.reporting_start_date as Date;
  const cash = clipSpanToAnchor(range.from, range.to, anchor);
  const month = clipSpanToAnchor(monthSpan.from, monthSpan.to, anchor);

  // ── A PERIOD ENTIRELY BEFORE THE ANCHOR HAS NO FIGURES, NOT ZERO ONES ────────────────────────
  // Answered instead of the tiles. "£0.00 revenue" is a claim about a month that traded badly, not
  // about a month nobody reported on, and zeros read as findings.
  if (cash.empty && month.empty) {
    return res.status(200).json({
      tiles: {}, from: range.from.toISOString(), to: range.to.toISOString(),
      monthFrom: monthSpan.from.toISOString(), monthTo: monthSpan.to.toISOString(),
      monthInProgress: false, daysElapsed: 0, daysInMonth: 0,
      reportingStart: anchor.toISOString(), beforeData: true,
    });
  }
  const base = { groupId: user.group_id as string, siteIds, now, dataStart: null }; // now reaches every compute (point-in-time ageing + in-progress-month window)
  // Each strip carries its OWN emptiness: the cash range and the month span are picked separately,
  // so a prior financial year on the profit tiles must not drag the cash tiles into silence, and a
  // pre-anchor month span must not be computed just because the cash range is fine.
  const tiles = await computeTiles(
    { ...base, from: cash.from, to: cash.to, empty: cash.empty },
    { ...base, from: month.from, to: month.to, months: month.months, selectedMonths: monthSpan.months, empty: month.empty },
  );
  // In-progress period (month, quarter OR financial year — any span containing `now`) → "N of M days,
  // fixed costs shown in full", net-profit reframes to "£X short of covering the period", and the
  // to-date treatment (sellable-to-date / effective rate) computes against the ELAPSED portion. Closed
  // period → false. daysInMonth/daysElapsed are the PERIOD's day counts (kept names for client compat).
  // Reported for the window ACTUALLY measured, not the one picked — every figure beside them
  // covers `month`, and a day count over a different span would quietly disagree with all of them.
  const monthInProgress = month.from.getTime() <= now.getTime() && now.getTime() < month.to.getTime();
  const daysInMonth = Math.round((month.to.getTime() - month.from.getTime()) / 86_400_000);
  const startOfTomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const elapsedEnd = monthInProgress ? Math.min(startOfTomorrow, month.to.getTime()) : month.to.getTime();
  const daysElapsed = Math.round((elapsedEnd - month.from.getTime()) / 86_400_000);
  // The forward strip is NOT part of `tiles`: those all report the selected period, and these three
  // deliberately ignore it. Keeping them separate is what stops a future reader assuming the picker
  // applies to them.
  const forward = await forwardCosts(user.group_id as string, siteIds, now);
  return res.status(200).json({
    tiles, forward, from: cash.from.toISOString(), to: cash.to.toISOString(),
    // monthFrom is the MEASURED start, so every label derived from it names the window the figures
    // cover. What the reader picked is `selectedMonthFrom`, and the difference is disclosed.
    monthFrom: month.from.toISOString(), monthTo: month.to.toISOString(),
    selectedMonthFrom: monthSpan.from.toISOString(),
    reportingStart: anchor.toISOString(), clipped: month.clipped || cash.clipped,
    monthInProgress, daysElapsed, daysInMonth,
    beforeData: false,
    // The tenant's own thresholds travel with the figures, so the light and the numbers it judges
    // arrive together and cannot be resolved from two different reads.
    utilThresholds: thresholdsFromGroup(grp),
  });
}
