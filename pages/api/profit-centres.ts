/**
 * File: pages/api/profit-centres.ts
 * Slice: Profit Centres & Resources admin (single site).
 *
 * CRUD for Profit Centres, scoped to the caller's group_id/site_id.
 * Auth/ownership pattern mirrors pages/api/settings/update.ts.
 *
 *   POST   { name, category, siteId? }            → create on siteId (any group site the caller may access; defaults to caller's site)
 *   PATCH  { id, name?, category?, is_active? }   → update (any group site the caller may access)
 *   DELETE { id }                                 → delete if unreferenced; else 409
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { ProfitCentreCategory } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';

const VALID_CATEGORIES = Object.values(ProfitCentreCategory) as string[];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;

  if (!user?.id || !user?.group_id || !user?.site_id) {
    return res.status(401).json({ message: 'Authentication Error: Group/Site context not found.' });
  }

  // Visibility: the set of sites the caller may act on (all group sites for an admin). All-locations
  // Financial can target any of these; a profit centre is "owned" if it sits on one of them.
  const vis = await getVisibility(user.id as string);
  if (!vis.siteIds.includes(user.site_id as string)) {
    return res.status(403).json({ message: 'You do not have permission for this site.' });
  }

  // Helper: confirm a profit centre belongs to a site the caller may access.
  async function ownPc(id: string) {
    if (!id) return null;
    return prisma.profitCentre.findFirst({ where: { id, site_id: { in: vis.siteIds } }, select: { id: true } });
  }

  if (req.method === 'POST') {
    const { name, category, siteId } = (req.body || {}) as { name?: string; category?: string; siteId?: string };
    const cleanName = (name || '').trim();
    if (!cleanName) return res.status(400).json({ message: 'Name is required.' });
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ message: `Category must be one of: ${VALID_CATEGORIES.join(', ')}.` });
    }
    // Target site: a group site the caller may access; defaults to their active site.
    // OPERATIONAL — a new profit centre belongs to a live location.
    const targetSite = typeof siteId === 'string' && vis.activeSiteIds.includes(siteId) ? siteId : (user.site_id as string);
    const created = await prisma.profitCentre.create({
      data: { site_id: targetSite, name: cleanName, category: category as ProfitCentreCategory },
      select: { id: true },
    });
    return res.status(201).json({ id: created.id, message: 'Profit centre created.' });
  }

  if (req.method === 'PATCH') {
    const { id, name, category, is_active } = (req.body || {}) as {
      id?: string;
      name?: string;
      category?: string;
      is_active?: boolean;
    };
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    if (!(await ownPc(id))) return res.status(404).json({ message: 'Profit centre not found.' });

    if (category !== undefined && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ message: `Category must be one of: ${VALID_CATEGORIES.join(', ')}.` });
    }

    const data: any = {};
    if (name !== undefined) {
      const cleanName = name.trim();
      if (!cleanName) return res.status(400).json({ message: 'Name cannot be empty.' });
      data.name = cleanName;
    }
    if (category !== undefined) data.category = category as ProfitCentreCategory;
    if (is_active !== undefined) data.is_active = !!is_active;

    await prisma.profitCentre.update({ where: { id }, data });
    return res.status(200).json({ message: 'Profit centre updated.' });
  }

  if (req.method === 'DELETE') {
    const id = (req.query.id as string) || (req.body && (req.body.id as string));
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    if (!(await ownPc(id))) return res.status(404).json({ message: 'Profit centre not found.' });

    // Guard: refuse to delete if referenced by job cards or bookings (FK is NoAction).
    const [jobCards, bookings] = await Promise.all([
      prisma.jobCard.count({ where: { profit_centre_id: id } }),
      prisma.booking.count({ where: { profit_centre_id: id } }),
    ]);
    if (jobCards > 0 || bookings > 0) {
      return res.status(409).json({
        message: `Cannot delete: this profit centre is used by ${jobCards} job card(s) and ${bookings} booking(s). Deactivate it instead.`,
      });
    }

    // Resources cascade-delete via the FK.
    await prisma.profitCentre.delete({ where: { id } });
    return res.status(200).json({ message: 'Profit centre deleted.' });
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
