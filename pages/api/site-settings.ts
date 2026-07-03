/**
 * File: pages/api/site-settings.ts
 * Per-site diary display settings: open days, opening hours, start-of-week. POST { siteId, ... }.
 * Gated to canManageSite (admin/owner or site-manager for that site).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { siteId, openDays, openHour, closeHour, weekStart, breaks } = (req.body || {}) as {
    siteId?: string; openDays?: number[]; openHour?: number; closeHour?: number; weekStart?: number; breaks?: Array<{ start: number; end: number }>;
  };
  if (!siteId) return res.status(400).json({ message: 'Missing siteId.' });

  const site = await prisma.site.findFirst({ where: { id: siteId, group_id: user.group_id }, select: { id: true } });
  if (!site) return res.status(404).json({ message: 'Location not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, siteId)) return res.status(403).json({ message: 'Only a manager or admin can change diary settings.' });

  // Validate.
  const days = Array.isArray(openDays)
    ? Array.from(new Set(openDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b)
    : undefined;
  if (days !== undefined && days.length === 0) return res.status(400).json({ message: 'Select at least one open day.' });
  const oh = Number(openHour), ch = Number(closeHour);
  if (openHour !== undefined && (!Number.isInteger(oh) || oh < 0 || oh > 23)) return res.status(400).json({ message: 'Opening hour must be 0–23.' });
  if (closeHour !== undefined && (!Number.isInteger(ch) || ch < 1 || ch > 24)) return res.status(400).json({ message: 'Closing hour must be 1–24.' });
  if (openHour !== undefined && closeHour !== undefined && oh >= ch) return res.status(400).json({ message: 'Opening hour must be before closing hour.' });
  const ws = Number(weekStart);
  if (weekStart !== undefined && ws !== 0 && ws !== 1) return res.status(400).json({ message: 'Week start must be Sunday or Monday.' });

  // Breaks: [{start,end}] minutes-from-midnight. Sanity-validate + reject overlaps (footprint clamps
  // them into open hours anyway). Empty array clears breaks.
  let brk: Array<{ start: number; end: number }> | undefined;
  if (breaks !== undefined) {
    if (!Array.isArray(breaks)) return res.status(400).json({ message: 'Invalid breaks.' });
    const cleaned = breaks
      .map((b) => ({ start: Math.round(Number(b?.start)), end: Math.round(Number(b?.end)) }))
      .filter((b) => Number.isInteger(b.start) && Number.isInteger(b.end) && b.start >= 0 && b.end <= 1440 && b.end > b.start)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < cleaned.length; i++) if (cleaned[i].start < cleaned[i - 1].end) return res.status(400).json({ message: 'Breaks must not overlap.' });
    brk = cleaned;
  }

  const data: any = {};
  if (days !== undefined) data.open_days = days;
  if (openHour !== undefined) data.open_hour = oh;
  if (closeHour !== undefined) data.close_hour = ch;
  if (weekStart !== undefined) data.week_start = ws;
  if (brk !== undefined) data.breaks = brk;
  if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update.' });

  await prisma.site.update({ where: { id: siteId }, data });
  return res.status(200).json({ message: 'Diary settings saved.' });
}
