/**
 * File: pages/api/jobcard-hold.ts
 * HOLD A CAR ON ITS BAY, or release it. PATCH { jobCardId, held: boolean }.
 *
 * A car waiting on parts is still bolted to a lift, and nothing in GreaseDesk said so: the bay was
 * offered to the next booking while the car sat in it. `held_since` says so — see lib/held-on-lift
 * for what a hold IS (a timestamp, valid only while the card is `in_progress`, derived rather than
 * cleared) and what reads it.
 *
 * OPERATIONAL authority, like the comeback flag: the person who knows the turbo has not arrived is
 * the mechanic standing next to the car, not the office. canAccessSite, any assigned user.
 *
 * ── IT NEVER REFUSES BECAUSE OF A LATER BOOKING ─────────────────────────────────────────────────
 * Holding a bay that already has a car booked onto it tomorrow is a real situation, and refusing to
 * record it does not move the car — it just means the diary goes on lying. So the hold is written
 * and the response NAMES what has become unreachable, for somebody to move. Recording reality is
 * never blocked by a consequence of reality.
 *
 * Idempotent: holding a held card, or releasing a free one, changes nothing and writes no audit row.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { canAccessSite, requireTenantApi } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { HELD_STATUS, isHeld } from '@/lib/held-on-lift';
import { FREES_THE_SLOT } from '@/lib/jobcard-status';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  // THE one tenant chokepoint, not the inline session read this file was first copied from: it
  // resolves the group through getVisibility rather than trusting a group_id on the session.
  const scope = await requireTenantApi(req, res);
  if (!scope) return;
  const { groupId, userId, vis } = scope;

  const { jobCardId, held } = (req.body || {}) as { jobCardId?: string; held?: boolean };
  if (!jobCardId || typeof held !== 'boolean') return res.status(400).json({ message: 'jobCardId and held are required.' });

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: { id: true, site_id: true, status: true, held_since: true, resource_id: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  // A HOLD IS A FACT ABOUT WORK IN PROGRESS. Refusing here rather than writing a timestamp that
  // lib/held-on-lift would then ignore: a column holding a value nothing reads is a thing somebody
  // later "fixes" by making it readable.
  if (held && card.status !== HELD_STATUS) {
    return res.status(409).json({ message: 'Only a job that is in progress can be held on its bay. Start the work first.' });
  }
  // A card with no bay cannot hold one.
  if (held && !card.resource_id) {
    return res.status(409).json({ message: 'This job is not on a bay, so there is nothing to hold.' });
  }
  if (isHeld(card) === held) return res.status(200).json({ message: 'No change.', blocked: [] });

  const now = new Date();
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.jobCard.update({
        where: { id: jobCardId },
        // Release writes NULL. The timestamp is not kept on release because the hold is OVER by a
        // deliberate act — unlike a card that moves status, where the stale value is the history.
        data: { held_since: held ? now : null },
      });
      await writeAudit(tx, {
        groupId,
        userId,
        jobCardId,
        action: held ? 'hold.placed' : 'hold.released',
        // The diff carries WHEN, so "nine days" can be checked against the trail rather than
        // believed. On release it carries the start it is ending, which the row no longer holds.
        diff: held ? { heldSince: now.toISOString() } : { heldSince: card.held_since?.toISOString() ?? null, releasedAt: now.toISOString() },
      });
    });
  } catch (e) {
    console.error('hold error:', e);
    return res.status(500).json({ message: 'Could not update the hold.' });
  }

  // WHAT THIS HAS JUST MADE UNREACHABLE — reported, never refused (see the header). Only asked on a
  // hold: a release frees the bay and can block nothing.
  let blocked: string[] = [];
  if (held && card.resource_id) {
    const later = await prisma.jobCard.findMany({
      // FREES_THE_SLOT, not a restated list: a status that no longer occupies the bay cannot be
      // blocked by a hold on it, and the one place that decides which those are is lib/jobcard-status.
      where: { id: { not: jobCardId }, resource_id: card.resource_id, status: { notIn: FREES_THE_SLOT }, end_at: { gt: now } },
      select: { vehicle: { select: { registration: true } } },
      orderBy: { start_at: 'asc' },
      take: 10,
    });
    blocked = later.map((c) => c.vehicle?.registration).filter((r): r is string => !!r);
  }
  return res.status(200).json({ message: held ? 'Held on bay.' : 'Released.', blocked });
}
