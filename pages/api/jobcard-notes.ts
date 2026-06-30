/**
 * File: pages/api/jobcard-notes.ts
 * Save the internal garage notes on a job card. POST { jobCardId, notes }.
 * OPERATIONAL authority — any user with access to the card's site (incl. STANDARD mechanics) may
 * edit notes; a user without site access is refused (403).
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

  const { jobCardId, notes } = (req.body || {}) as { jobCardId?: string; notes?: string };
  if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });

  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) {
    return res.status(403).json({ message: 'You do not have access to this job card’s location.' });
  }

  const value = notes == null ? null : String(notes).trim() || null;
  await prisma.jobCard.update({ where: { id: jobCardId }, data: { garage_notes: value } });
  return res.status(200).json({ message: 'Notes saved.', notes: value });
}
