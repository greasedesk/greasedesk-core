/**
 * File: pages/api/pwa/day.ts
 * GET [?site=][&date=yyyy-mm-dd] → the DIARY DAY, phone-shaped — and ONLY the diary day: day
 * notes + the day's bookings in time order. Bookings and notes come from THE shared diary-day chokepoint
 * (lib/diary-day — the SAME functions the desktop diary gssp calls), so the office and the floor
 * can never see different days. Identity and site resolve from the SESSION; ?site only selects
 * among the caller's own sites; ?date is a calendar day (default: today, London).
 * MONEY IS PROJECTED OUT server-side — absent, not hidden: the shared select carries money fields
 * for the desktop's financeVisibility-gated totals, and NONE of them leave this endpoint, for any
 * role. No price, no Booked total, no Margin ever lands on a shop-floor handset.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { fetchDayBookings, fetchDayNotes, serviceLabels } from '@/lib/diary-day';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store'); // freshness is the client cache's job (IndexedDB)
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.siteIds.length) return res.status(200).json({ siteId: null, siteName: '', sites: [], date: null, isToday: true, notes: [], booked: [] });

  // ?site is a SELECTION among the caller's own sites — anything else falls back to primary.
  const requested = typeof req.query.site === 'string' ? req.query.site : null;
  const siteId = requested && vis.siteIds.includes(requested) ? requested : (vis.primarySiteId ?? vis.siteIds[0]);

  // Today on the London calendar (the diary's date convention); ?date navigates other days.
  const [d, m, y] = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' }).split('/');
  const todayStr = `${y}-${m}-${d}`;
  const reqDate = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : todayStr;
  const dayStart = new Date(`${reqDate}T00:00:00Z`);
  if (Number.isNaN(dayStart.getTime())) return res.status(400).json({ message: 'Invalid date.' });
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const [thisSite, sites, bookings, notes] = await Promise.all([
    prisma.site.findUnique({ where: { id: siteId }, select: { site_name: true, group_id: true } }) as Promise<any>,
    vis.siteIds.length > 1
      ? (prisma.site.findMany({ where: { id: { in: vis.siteIds } }, orderBy: { created_at: 'asc' }, select: { id: true, site_name: true } }) as Promise<any[]>)
      : Promise.resolve([]),
    fetchDayBookings(siteId, dayStart, dayEnd),   // THE diary's booking read
    fetchDayNotes(siteId, dayStart, dayEnd),      // THE diary's note read — verbatim block
  ]);
  if (thisSite?.group_id !== user.group_id) return res.status(404).json({ message: 'Site not found.' }); // belt-and-braces tenant check

  // PROJECTION — the money fields on the shared select STOP HERE. Explicit whitelist only.
  const shape = (c: any) => {
    const { summary } = serviceLabels(c.items ?? []);
    return {
      id: c.id,
      startAt: c.start_at ? (c.start_at as Date).toISOString() : null,
      endAt: c.end_at ? (c.end_at as Date).toISOString() : null,
      reg: c.vehicle?.registration ?? '—',
      customer: c.customer?.name ?? '—',
      resourceName: c.resource?.name ?? null,
      service: summary,
      status: c.status as string,
      isComeback: !!c.is_comeback,
      heldOnLift: !!c.held_on_lift,
    };
  };

  const booked = [...bookings].sort((a, b) => (a.start_at as Date).getTime() - (b.start_at as Date).getTime()).map(shape);

  return res.status(200).json({
    siteId,
    siteName: thisSite?.site_name ?? '',
    sites: sites.map((s) => ({ id: s.id, name: s.site_name })),
    date: reqDate,
    isToday: reqDate === todayStr,
    notes: notes.map((n) => ({ id: n.id, title: n.title, colour: n.colour ?? null, startAt: (n.start_at as Date).toISOString(), endAt: (n.end_at as Date).toISOString(), resourceId: n.resource_id ?? null })),
    booked,
  });
}
