/**
 * File: pages/api/jobcard-accept.ts
 * Accept a quote AND book it in ONE atomic step. POST { jobCardId, resourceId, startAt, endAt, heldOnLift? }.
 *
 * Mirrors the proven invoice-mint-on-`invoiced` side-effect pattern: inside a single transaction we
 * placeJobCard (the shared double-booking guard, which THROWS on clash) and only then flip the status
 * quoted→accepted (or declined→accepted reopen). If the slot clashes, placeJobCard throws, the tx
 * rolls back, and the card stays quoted — never accepted-but-unbooked. Commercial authority (accept
 * is a commercial transition): canManageSite.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { findTransition, JobStatus } from '@/lib/jobcard-status';
import { placeJobCard } from '@/lib/diary-booking';
import { writeAudit } from '@/lib/audit';
import { acceptQuote } from '@/lib/quote-acceptance';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, resourceId, startAt, endAt, workingMinutes: wmIn } = (req.body || {}) as {
    jobCardId?: string; resourceId?: string; startAt?: string; endAt?: string; workingMinutes?: number;
  };
  if (!jobCardId || !resourceId || !startAt) {
    return res.status(400).json({ message: 'Pick a lift, a start and a duration to accept & book.' });
  }
  const start = new Date(startAt);
  // Duration is the source of truth. Bridge: a caller still sending endAt (or the old naive form)
  // yields the same working-minutes via (end - start), since naive end = start + duration.
  const workingMinutes = wmIn ?? (endAt ? Math.round((Date.parse(endAt) - start.getTime()) / 60000) : NaN);
  if (Number.isNaN(start.getTime()) || !(workingMinutes > 0)) {
    return res.status(400).json({ message: 'Pick a valid start and duration.' });
  }

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, site_id: true, status: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  // Accept is a commercial transition; it must be a valid move from the current status.
  const tr = findTransition(card.status as JobStatus, 'accepted');
  if (!tr) return res.status(400).json({ message: `Cannot accept from ${card.status}.` });

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, card.site_id)) {
    return res.status(403).json({ message: 'Only a manager or admin can accept and book a job.' });
  }
  // NOT GATED HERE (2026-08-06). Accepting is continuing work — the enquiry already exists and the
  // customer has just said yes. The BOOKING half of this endpoint is gated where every other
  // booking path is, inside placeJobCard, which throws BILLING_RESTRICTED and is caught below.
  // The old comment said "booking a job is new work" — true, but it gated the acceptance too.

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1) book first — throws CLASH:<reg> / CROSS_SITE / RESOURCE_NOT_FOUND → rolls the whole thing back
      await placeJobCard(tx, { jobCardId, resourceId, start, workingMinutes, siteIds: vis.activeSiteIds }); // booking on accept = new work
      // 2) only then advance the lifecycle — through the ONE acceptance rule. This used to write
      //    the card status directly and never touch QuoteVersion, so accepting a card that had a
      //    live quote out left that version reading `sent` forever: orphaned, and still listed as
      //    Awaiting. acceptQuote answers the version, stamps accepted_at and writes the audit row.
      await acceptQuote(tx, {
        groupId: user.group_id as string, jobCardId, via: 'booked',
        actorUserId: user.id as string,
        attested: null, // a manager booking the work is not the customer clicking a link
        at: new Date(),
      });
      // 3) the BOOKING is a separate fact from the acceptance and keeps its own row — the diary
      //    placement is what this endpoint uniquely did, and it must stay legible in the history.
      await writeAudit(tx, {
        groupId: user.group_id as string, userId: user.id as string, jobCardId,
        action: 'booking.placed', diff: { resourceId, startAt, workingMinutes, from: card.status, via: 'accept_and_book' },
      });
    });
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    if (msg === 'BILLING_RESTRICTED') return res.status(402).json({ code: 'billing_restricted', message: 'Your subscription payment hasn’t arrived, so new bookings are paused. Everything already in the workshop can be finished, quoted and invoiced as normal.' });
    if (msg.startsWith('CLASH:')) {
      return res.status(409).json({ code: 'CLASH', message: 'That resource isn’t available for that duration. The quote stays quoted.' });
    }
    if (msg === 'EMPTY_FOOTPRINT') return res.status(400).json({ message: 'Pick a valid duration.' });
    if (msg === 'CROSS_SITE' || msg === 'RESOURCE_NOT_FOUND') return res.status(400).json({ message: 'That lift is not available for this job’s location.' });
    if (msg === 'CARD_NOT_FOUND') return res.status(404).json({ message: 'Job card not found.' });
    console.error('Accept-and-book error:', e);
    return res.status(500).json({ message: 'Could not accept and book the job.' });
  }
  return res.status(200).json({ message: 'Accepted and booked.', status: 'accepted' });
}
