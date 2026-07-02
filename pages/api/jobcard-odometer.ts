/**
 * File: pages/api/jobcard-odometer.ts
 * Capture the "mileage out" reading at Completion. POST { jobCardId, odometerOut }.
 * Additive use of the existing (nullable) JobCard.odometer_out column — the advisories grain seed:
 * capturing it now means the historical mileage delta accumulates before the advisories lens exists.
 * OPERATIONAL authority (any site-assigned user). Non-gating.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, odometerOut } = (req.body || {}) as { jobCardId?: string; odometerOut?: number | string | null };
  if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });

  let value: number | null = null;
  if (odometerOut !== null && odometerOut !== undefined && String(odometerOut).trim() !== '') {
    const n = Number(odometerOut);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ message: 'Invalid mileage.' });
    value = Math.trunc(n);
  }

  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  await prisma.jobCard.update({ where: { id: jobCardId }, data: { odometer_out: value } });
  return res.status(200).json({ message: 'Mileage saved.', odometerOut: value });
}
