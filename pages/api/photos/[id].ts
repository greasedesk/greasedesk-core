/**
 * File: pages/api/photos/[id].ts
 * DELETE a photo (row + R2 object). Allowed while the photo's STAGE is not yet marked complete; once the
 * stage is locked, only a SITE MANAGER / ADMIN may remove it (the override). Operational otherwise.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite, canManageSite } from '@/lib/admin-guard';
import { deleteObject } from '@/lib/r2';

const STAGE_DONE: Record<string, 'stage_intake_done' | 'stage_injob_done' | 'stage_complete_done'> = {
  intake: 'stage_intake_done', injob: 'stage_injob_done', completion: 'stage_complete_done',
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'DELETE') { res.setHeader('Allow', 'DELETE'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const id = String(req.query.id || '');
  const photo = await prisma.jobCardPhoto.findFirst({
    where: { id, group_id: user.group_id },
    select: { id: true, stage: true, r2_key: true, job_card: { select: { id: true, site_id: true, stage_intake_done: true, stage_injob_done: true, stage_complete_done: true } } },
  }) as any;
  if (!photo || !photo.job_card) return res.status(404).json({ message: 'Photo not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, photo.job_card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  // Locked once the stage is complete — only a manager/admin can then remove (the override).
  const col = STAGE_DONE[photo.stage as string];
  const locked = col ? !!photo.job_card[col] : false;
  if (locked && !canManageSite(vis, photo.job_card.site_id)) {
    return res.status(409).json({ message: 'This stage is complete — only a manager can remove its photos.' });
  }

  await prisma.jobCardPhoto.delete({ where: { id } });
  if (photo.r2_key) await deleteObject(photo.r2_key); // best-effort; the row is the source of truth
  return res.status(200).json({ message: 'Photo deleted.' });
}
