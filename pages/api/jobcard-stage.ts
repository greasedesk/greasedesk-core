/**
 * File: pages/api/jobcard-stage.ts
 * Toggle one of the four operational stage flags (Details / Intake / In-Job / Completion).
 * POST { jobCardId, stage, done }. OPERATIONAL authority — any site-assigned user (incl. STANDARD
 * mechanics) may toggle; a user without access to the card's site is refused (403).
 *
 * Gating (server-side twin of the UI greying — same chokepoint, so they can't disagree): a stage may
 * only be toggled once its TAB is reachable (computeTabs). Details additionally requires the minimum
 * owner + vehicle data before it can be marked complete. The stage flags still gate the
 * in_progress→invoiced transition. Each toggle is audited in the same tx.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { isStageKey, STAGE_COLUMN, isSkippableStage, SKIP_COLUMN, JobStatus, StageKey } from '@/lib/jobcard-status';
import { computeTabs, tabForStage, detailsMinDataMet } from '@/lib/jobcard-tabs';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  // skip=true toggles the SKIP flag instead of the done flag (soft gate — advances without capture).
  // A skip is a first-class audited event: actor+timestamp from the audit row, optional free-text reason.
  const { jobCardId, stage, done, skip, reason } = (req.body || {}) as { jobCardId?: string; stage?: string; done?: boolean; skip?: boolean; reason?: string };
  if (!jobCardId || !isStageKey(stage)) return res.status(400).json({ message: 'Missing jobCardId or invalid stage.' });
  if (skip && !isSkippableStage(stage)) return res.status(400).json({ message: 'This step can’t be skipped.' });

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, status: true, vehicle_id: true,
      stage_details_done: true, stage_intake_done: true, stage_injob_done: true, stage_complete_done: true,
      stage_intake_skipped: true, stage_injob_skipped: true, stage_complete_skipped: true,
      vehicle: { select: { registration: true } },
    },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) {
    return res.status(403).json({ message: 'You do not have access to this job card’s location.' });
  }

  // Reachability guard, read from the SAME chokepoint the UI greys with. Owner resolves via the edge.
  const ownerId = await getCurrentOwnerId(prisma, card.vehicle_id as string);
  const gate = {
    status: card.status as JobStatus,
    stages: {
      details: card.stage_details_done, intake: card.stage_intake_done,
      injob: card.stage_injob_done, complete: card.stage_complete_done,
    } as Record<StageKey, boolean>,
    skipped: { intake: card.stage_intake_skipped, injob: card.stage_injob_skipped, complete: card.stage_complete_skipped },
    hasOwner: !!ownerId,
    hasRegistration: !!(card.vehicle?.registration && String(card.vehicle.registration).trim()),
  };
  const tabs = computeTabs(gate);
  if (!tabs[tabForStage(stage)].reachable) {
    return res.status(409).json({ message: 'Complete the previous step before this one.' });
  }
  if (stage === 'details' && done && !detailsMinDataMet(gate)) {
    return res.status(409).json({ message: 'Add the customer and the registration before completing Customer Details.' });
  }

  // Skip rules: can't skip an already-completed stage; completing a stage clears its skip flag
  // (done wins — the honest state). Un-skip = skip:true, done:false.
  if (skip && done && (card as any)[STAGE_COLUMN[stage]]) {
    return res.status(409).json({ message: 'This step is already completed.' });
  }

  const data: any = skip
    ? { [SKIP_COLUMN[stage as 'intake' | 'injob' | 'complete']]: !!done }
    : { [STAGE_COLUMN[stage]]: !!done, ...(isSkippableStage(stage) && done ? { [SKIP_COLUMN[stage]]: false } : {}) };
  const action = skip ? `stage.${stage}.${done ? 'skipped' : 'unskipped'}` : `stage.${stage}.${done ? 'done' : 'undone'}`;
  const trimmedReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : null;

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const row = (await tx.jobCard.update({
      where: { id: jobCardId },
      data,
      select: {
        stage_details_done: true, stage_intake_done: true, stage_injob_done: true, stage_complete_done: true,
        stage_intake_skipped: true, stage_injob_skipped: true, stage_complete_skipped: true,
      },
    })) as any;
    await writeAudit(tx, {
      groupId: user.group_id as string, userId: user.id as string, jobCardId,
      action: action as any,
      diff: skip && done && trimmedReason ? { reason: trimmedReason } : undefined,
    });
    return row;
  });

  return res.status(200).json({
    message: 'Stage updated.',
    stages: {
      details: updated.stage_details_done, intake: updated.stage_intake_done,
      injob: updated.stage_injob_done, complete: updated.stage_complete_done,
    },
    skipped: {
      intake: updated.stage_intake_skipped, injob: updated.stage_injob_skipped, complete: updated.stage_complete_skipped,
    },
  });
}
