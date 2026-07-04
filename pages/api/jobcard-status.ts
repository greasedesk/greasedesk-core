/**
 * File: pages/api/jobcard-status.ts
 * Transition a job card's lifecycle status. POST { jobCardId, to }.
 * The state machine (lib/jobcard-status.ts) is the only place transitions/authority/gates live:
 *  - invalid jump → 400
 *  - operational transition needs canAccessSite; commercial needs canManageSite → 403 otherwise
 *  - gate unmet (estimate_exists / all_stages_done) → 409 with a clear reason
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite, canManageSite } from '@/lib/admin-guard';
import { findTransition, JobStatus } from '@/lib/jobcard-status';
import { issueInvoiceForCard } from '@/lib/invoice-issue';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, to } = (req.body || {}) as { jobCardId?: string; to?: JobStatus };
  if (!jobCardId || !to) return res.status(400).json({ message: 'Missing jobCardId or target status.' });

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, status: true, is_comeback: true,
      stage_details_done: true, stage_intake_done: true, stage_injob_done: true, stage_complete_done: true,
      _count: { select: { items: true } },
    },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  // Comeback = never invoiced (no bill, no sequential VAT number burned). Block the invoiced transition
  // and give it a completion route instead: in_progress → done (operational, stages gated). Cost is
  // still captured on the estimate lines; the job just never bills.
  if (to === 'invoiced' && card.is_comeback) {
    return res.status(409).json({ message: 'A comeback isn’t invoiced — mark it complete instead.' });
  }
  const comebackComplete = to === 'done' && card.status === 'in_progress' && card.is_comeback;
  const tr = comebackComplete
    ? { to: 'done' as JobStatus, kind: 'operational' as const, gate: 'all_stages_done' as const }
    : findTransition(card.status as JobStatus, to);
  if (!tr) return res.status(400).json({ message: `Cannot move from ${card.status} to ${to}.` });

  const vis = await getVisibility(user.id as string);
  const permitted = tr.kind === 'operational' ? canAccessSite(vis, card.site_id) : canManageSite(vis, card.site_id);
  if (!permitted) {
    return res.status(403).json({
      message: tr.kind === 'commercial'
        ? 'Only a manager or admin can make this change.'
        : 'You do not have access to this job card’s location.',
    });
  }

  // Gates.
  if (tr.gate === 'estimate_exists' && (card._count?.items ?? 0) === 0) {
    return res.status(409).json({ message: 'Add at least one estimate line before quoting.' });
  }
  if (tr.gate === 'all_stages_done') {
    const allDone = card.stage_details_done && card.stage_intake_done && card.stage_injob_done && card.stage_complete_done;
    if (!allDone) return res.status(409).json({ message: 'Complete all four stages first.' });
  }

  // Apply the transition + its side effects atomically.
  //  - invoiced: mint the invoice (once — sticky via Invoice.job_card_id @unique). The mint runs in
  //    THIS tx, so if anything fails the sequence increment rolls back too (no gap, no burned number).
  //  - paid: freeze the invoice (status=paid, paid_at) → canEditInvoice flips to false.
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCard.update({ where: { id: jobCardId }, data: { status: to } });
      await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: `status.${to}`, diff: { from: card.status, to } });
      if (to === 'invoiced') {
        const existing = await tx.invoice.findUnique({ where: { job_card_id: jobCardId }, select: { id: true } });
        if (!existing) {
          await issueInvoiceForCard(tx, jobCardId, user.group_id as string);
          await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.minted' });
        }
      } else if (to === 'paid') {
        await tx.invoice.updateMany({ where: { job_card_id: jobCardId, status: 'issued' }, data: { status: 'paid', paid_at: new Date() } });
        await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId, action: 'invoice.paid' });
      }
    });
  } catch (e) {
    console.error('Status transition error:', e);
    return res.status(500).json({ message: 'Failed to update status.' });
  }
  return res.status(200).json({ message: 'Status updated.', status: to });
}
