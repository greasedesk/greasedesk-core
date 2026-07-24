/**
 * File: pages/api/jobcard-share.ts
 * POST { jobCardId, purpose?, email? } → mint a customer magic link and email it.
 * The ONE place staff hand a customer a link: it goes through BOTH chokepoints — lib/magic-link to
 * mint the credential, lib/notify to send and RECORD it. Never mint a link without recording who it
 * went to; the audit answer "who could see this card?" is CustomerMagicLink + NotificationLog.
 *
 * Authority: an operational user on a site they can access (same tier as editing the card). Billing
 * gate applies — issuing a link is a WRITE (it creates a credential), so a lapsed tenant can't.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { canWrite } from '@/lib/billing';
import { createMagicLink, type MagicPurpose } from '@/lib/magic-link';
import { sendNotification } from '@/lib/notify';

const PURPOSES: MagicPurpose[] = ['quote_view', 'portal_view'];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, purpose: rawPurpose, email: rawEmail } = (req.body ?? {}) as Record<string, string>;
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });
  const purpose = (PURPOSES.includes(rawPurpose as MagicPurpose) ? rawPurpose : 'quote_view') as MagicPurpose;

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, group_id: true,
      vehicle: { select: { registration: true } },
      customer: { select: { email: true } },
      group: { select: { group_name: true, trading_name: true, billing: { select: { subscription_status: true, status: true } } } },
    },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You don’t have access to that job card.' });
  if (!canWrite({ subscriptionStatus: card.group.billing?.subscription_status ?? null, status: card.group.billing?.status ?? null })) {
    return res.status(402).json({ message: 'Your subscription is inactive — sharing is a write and is paused.' });
  }

  const recipient = (rawEmail || card.customer?.email || '').trim();
  if (!recipient) return res.status(400).json({ message: 'No customer email on this job card — add one or pass an address.' });

  const garageName = card.group.trading_name || card.group.group_name || 'Your garage';
  const link = await createMagicLink({
    groupId: card.group_id,
    jobCardId: card.id,
    purpose,
    recipient,
    createdByUserId: user.id as string,
  });

  const sent = await sendNotification({
    recipient,
    template: purpose === 'quote_view' ? 'quote_ready' : 'job_card_link',
    channel: 'email',
    groupId: card.group_id,
    subject: { type: 'job_card', id: card.id },
    data: {
      garageName,
      registration: card.vehicle?.registration ?? null,
      link: link.url,
      expiryDays: 14,
    },
  });

  // The link exists even if the email failed — staff can copy it manually rather than re-mint.
  return res.status(200).json({
    ok: sent.ok,
    magicLinkId: link.id,
    url: link.url,
    expiresAt: link.expiresAt.toISOString(),
    notificationId: sent.notificationId,
    deliveryStatus: sent.status,
    ...(sent.ok ? {} : { message: sent.reason ?? 'The link was created but the email could not be sent.' }),
  });
}
