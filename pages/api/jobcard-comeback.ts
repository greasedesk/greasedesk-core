/**
 * File: pages/api/jobcard-comeback.ts
 * Toggle a job card's warranty/comeback flag. PATCH { jobCardId, isComeback }.
 * A comeback is real cost / zero revenue — the flag is the reporting hook (revenue 0; the drag is the
 * PARTS cost only, labour being fixed overhead). A mechanic knows a job came back → OPERATIONAL authority
 * (canAccessSite, any assigned user). Audited.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, isComeback } = (req.body || {}) as { jobCardId?: string; isComeback?: boolean };
  if (!jobCardId || typeof isComeback !== 'boolean') return res.status(400).json({ message: 'jobCardId and isComeback are required.' });

  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true, is_comeback: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  if (card.is_comeback === isComeback) return res.status(200).json({ message: 'No change.' }); // idempotent

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCard.update({ where: { id: jobCardId }, data: { is_comeback: isComeback } });
      await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: isComeback ? 'comeback.marked' : 'comeback.cleared' });
    });
  } catch (e) {
    console.error('comeback flag error:', e);
    return res.status(500).json({ message: 'Could not update the comeback flag.' });
  }
  return res.status(200).json({ message: 'Comeback flag updated.' });
}
