/**
 * File: pages/api/jobcard-stage.ts
 * Toggle one of the four operational stage flags (Job Card / Intake / In-Job / Complete).
 * POST { jobCardId, stage, done }. OPERATIONAL authority — any site-assigned user (incl. STANDARD
 * mechanics) may toggle; a user without access to the card's site is refused (403). Independent of
 * status; these flags only GATE the in_progress→invoiced transition.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { isStageKey, STAGE_COLUMN } from '@/lib/jobcard-status';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, stage, done } = (req.body || {}) as { jobCardId?: string; stage?: string; done?: boolean };
  if (!jobCardId || !isStageKey(stage)) return res.status(400).json({ message: 'Missing jobCardId or invalid stage.' });

  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) {
    return res.status(403).json({ message: 'You do not have access to this job card’s location.' });
  }

  const updated = (await prisma.jobCard.update({
    where: { id: jobCardId },
    data: { [STAGE_COLUMN[stage]]: !!done },
    select: { stage_details_done: true, stage_intake_done: true, stage_injob_done: true, stage_complete_done: true },
  })) as any;

  return res.status(200).json({
    message: 'Stage updated.',
    stages: {
      details: updated.stage_details_done, intake: updated.stage_intake_done,
      injob: updated.stage_injob_done, complete: updated.stage_complete_done,
    },
  });
}
