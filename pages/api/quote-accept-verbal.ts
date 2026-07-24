/**
 * File: pages/api/quote-accept-verbal.ts
 * POST { jobCardId } — a STAFF user records an acceptance the customer gave by phone or over the
 * counter. Real and common; it just isn't the same evidence as the customer clicking their own link.
 *
 * THE RECORD MUST NOT LIE. The customer-link path captures IP + user-agent because the customer's
 * own device produced them. Here the request comes from the GARAGE's browser, so an IP and
 * user-agent would describe the receptionist, not the customer — recording them would manufacture
 * false attestation. Instead we record WHO on staff marked it, WHEN, and that it was verbal, and we
 * leave responded_ip / responded_user_agent NULL. That absence is the honest signal, and it is what
 * makes the two routes distinguishable:
 *     responded_by_user NULL + ip/ua present  → CUSTOMER-ATTESTED (they clicked their link)
 *     responded_by_user SET  + ip/ua null     → GARAGE-RECORDED (taken verbally)
 * Audit actions differ too: quote.accepted vs quote.accepted_verbal.
 *
 * If a sent version exists it is FROZEN as accepted, so the invoice still inherits the exact figures
 * that were quoted. If none exists (a verbal quote never sent) the card simply accepts, and the
 * invoice falls through to live JobCardItem — the existing, unchanged fallback.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { requireCanWrite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId } = (req.body ?? {}) as { jobCardId?: string };
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, site_id: true, group_id: true, status: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You don’t have access to that job card.' });
  if (!(await requireCanWrite(user.group_id as string, res))) return;

  if (!['draft', 'quoted', 'declined'].includes(card.status)) {
    return res.status(409).json({ message: `A ${card.status} job can’t be marked accepted.` });
  }

  // The live offer, if one was ever sent. Only a `sent` version can be accepted — an already
  // accepted/declined one has an answer, and a superseded one is no longer the offer.
  const live = await prisma.quoteVersion.findFirst({
    where: { job_card_id: card.id, status: 'sent' },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, gross_pennies: true },
  });

  const now = new Date();
  await prisma.$transaction(async (tx: any) => {
    if (live) {
      await tx.quoteVersion.update({
        where: { id: live.id },
        data: {
          status: 'accepted',
          responded_at: now,
          responded_by_user: user.id as string, // GARAGE-RECORDED
          // responded_ip / responded_user_agent stay NULL on purpose — see the header.
        },
      });
    }
    await tx.jobCard.update({ where: { id: card.id }, data: { status: 'accepted' } });
    await writeAudit(tx, {
      groupId: card.group_id,
      userId: user.id as string, // the STAFF actor — unlike the customer path, which has no user
      jobCardId: card.id,
      action: 'quote.accepted_verbal',
      diff: {
        via: 'phone_or_counter',
        attested: false, // NOT customer-attested; the distinction the audit exists to preserve
        version: live?.version ?? null,
        grossPennies: live?.gross_pennies ?? null,
        frozenVersion: !!live, // false = no version existed; the invoice will use live JobCardItem
        at: now.toISOString(),
      },
    });
  });

  return res.status(200).json({
    ok: true,
    frozenVersion: !!live,
    version: live?.version ?? null,
    message: live
      ? `Accepted — quote v${live.version} is frozen as the agreed figures.`
      : 'Accepted — no quote was sent, so the invoice will use the current estimate.',
  });
}
