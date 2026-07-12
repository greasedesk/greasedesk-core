/**
 * File: pages/api/pwa/day.ts
 * GET [?site=] → the SITE's day for the phone surface: today's booked jobs, time · reg · service ·
 * status. Identity and site resolve from the SESSION (getVisibility) — the client never asserts
 * who it is; ?site only SELECTS among the sites the server already resolved for this user and is
 * validated against them. NO MONEY on this surface (v1): no prices, no costs, no values — money
 * arrives on the card read, shaped by financeVisibility there.
 * It is deliberately the site's day, not a person's: jobs are shared (two on a lift, an apprentice
 * speeding up a senior); mechanic_assigned_id stays unwritten — this is the bay board in a pocket.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store'); // freshness is the client cache's job (IndexedDB)
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.siteIds.length) return res.status(200).json({ siteId: null, sites: [], date: null, jobs: [] });

  // ?site is a SELECTION among the caller's own sites — anything else falls back to primary.
  const requested = typeof req.query.site === 'string' ? req.query.site : null;
  const siteId = requested && vis.siteIds.includes(requested) ? requested : (vis.primarySiteId ?? vis.siteIds[0]);

  // Today on the London calendar → the UTC-midnight window (the diary's date convention:
  // UTC-midnight stamps align to London dates year-round).
  const [d, m, y] = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' }).split('/');
  const dayStart = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const [sites, cards] = await Promise.all([
    vis.siteIds.length > 1
      ? (prisma.site.findMany({ where: { id: { in: vis.siteIds } }, orderBy: { created_at: 'asc' }, select: { id: true, site_name: true } }) as Promise<any[]>)
      : Promise.resolve([]),
    // The diary's day query, list-shaped: booked cards overlapping today at this site.
    prisma.jobCard.findMany({
      where: { group_id: user.group_id, site_id: siteId, resource_id: { not: null }, start_at: { lt: dayEnd }, end_at: { gt: dayStart } },
      orderBy: { start_at: 'asc' },
      select: {
        id: true, start_at: true, end_at: true, status: true, is_comeback: true,
        vehicle: { select: { registration: true } },
        items: { select: { item_type: true, description: true } }, // descriptions ONLY — no money fields leave this endpoint
      },
    }) as Promise<any[]>,
  ]);

  // Service label = the diary's derivation: fixed-line TITLES first, "First +N" beyond one.
  const firstLine = (s: string) => (s || '').split('\n')[0].trim();
  const jobs = cards.map((c) => {
    const fixedNames = c.items.filter((it: any) => it.item_type === 'fixed').map((it: any) => firstLine(it.description)).filter(Boolean);
    const labels = fixedNames.length ? fixedNames : c.items.map((it: any) => firstLine(it.description)).filter(Boolean);
    return {
      id: c.id,
      startAt: (c.start_at as Date).toISOString(),
      endAt: (c.end_at as Date).toISOString(),
      reg: c.vehicle?.registration ?? '—',
      service: labels.length ? (labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0]) : '',
      status: c.status as string,
      isComeback: !!c.is_comeback,
    };
  });

  return res.status(200).json({
    siteId,
    sites: sites.map((s) => ({ id: s.id, name: s.site_name })),
    date: dayStart.toISOString().slice(0, 10),
    jobs,
  });
}
