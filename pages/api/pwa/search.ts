/**
 * File: pages/api/pwa/search.ts
 * GET ?q= → reg search across the caller's OWN sites (session-resolved, as always) — the escape
 * hatch for everything the day list doesn't show. A mechanic always knows the reg: it's on the
 * car in front of him. NO MONEY in the results. Newest cards first, capped small.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const q = String(req.query.q || '').replace(/\s+/g, '').trim();
  if (q.length < 2) return res.status(200).json({ results: [] });

  const vis = await getVisibility(user.id as string);
  if (!vis.siteIds.length) return res.status(200).json({ results: [] });

  const cards = (await prisma.jobCard.findMany({
    where: {
      group_id: user.group_id,
      site_id: { in: vis.siteIds }, // ALL the caller's sites — the reg matters more than the switcher
      vehicle: { registration: { contains: q, mode: 'insensitive' } },
    },
    orderBy: { created_at: 'desc' },
    take: 10,
    select: {
      id: true, status: true, is_comeback: true, created_at: true, site_id: true,
      vehicle: { select: { registration: true } },
      items: { select: { item_type: true, description: true } }, // descriptions only — no money
      site: { select: { site_name: true } },
    },
  })) as any[];

  const firstLine = (s: string) => (s || '').split('\n')[0].trim();
  const results = cards.map((c) => {
    const fixedNames = c.items.filter((it: any) => it.item_type === 'fixed').map((it: any) => firstLine(it.description)).filter(Boolean);
    const labels = fixedNames.length ? fixedNames : c.items.map((it: any) => firstLine(it.description)).filter(Boolean);
    return {
      id: c.id,
      reg: c.vehicle?.registration ?? '—',
      service: labels.length ? (labels.length > 1 ? `${labels[0]} +${labels.length - 1}` : labels[0]) : '',
      status: c.status as string,
      createdAt: (c.created_at as Date).toISOString().slice(0, 10),
      siteName: vis.siteIds.length > 1 ? (c.site?.site_name ?? '') : '', // named only when it disambiguates
    };
  });
  return res.status(200).json({ results });
}
