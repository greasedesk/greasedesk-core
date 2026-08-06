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
import { acceptQuote } from '@/lib/quote-acceptance';

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
  // NOT GATED (2026-08-06): recording that a customer said yes over the counter is continuing
  // work on an enquiry that already exists. It takes no workshop slot.

  if (!['draft', 'quoted', 'declined'].includes(card.status)) {
    return res.status(409).json({ message: `A ${card.status} job can’t be marked accepted.` });
  }

  const now = new Date();
  // ONE acceptance rule. The `if (live)` branch that used to sit here is gone: acceptQuote handles
  // both shapes, and the versionless case — which is the COMMON one — now records the fact on the
  // card instead of only in an audit row. No version is minted; see lib/quote-acceptance.
  const result = await prisma.$transaction(async (tx: any) =>
    acceptQuote(tx, {
      groupId: card.group_id, jobCardId: card.id, via: 'counter',
      actorUserId: user.id as string,
      attested: null, // GARAGE-RECORDED — no ip/ua, because no customer was on the other end of one
      at: now,
    }),
  );

  return res.status(200).json({
    ok: true,
    frozenVersion: !!result.versionId,
    version: result.version,
    // The wording follows what actually happened, and the versionless branch says out loud which
    // figures the invoice will use — the whole reason no version is minted here.
    message: result.alreadyAccepted
      ? 'This job was already accepted.'
      : result.version != null
        ? `Accepted — quote v${result.version} is frozen as the agreed figures.`
        : 'Accepted — no quote was sent, so the invoice will use the current estimate.',
  });
}
