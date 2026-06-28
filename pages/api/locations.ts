/**
 * File: pages/api/locations.ts
 * GET → the caller's group's locations (Sites) + the current site_id, for the top-bar
 * location navigation. Read-only, tenant-scoped.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  const sites = await prisma.site.findMany({
    where: { group_id: user.group_id },
    orderBy: { site_name: 'asc' },
    select: { id: true, site_name: true },
  });

  return res.status(200).json({ currentSiteId: user.site_id, locations: sites });
}
