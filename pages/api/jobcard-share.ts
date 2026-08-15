/**
 * File: pages/api/jobcard-share.ts
 * POST { jobCardId, purpose?, email?, channel? } → mint a customer magic link and send it.
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
import { sendNotification, type NotifyChannel } from '@/lib/notify';
import { reachabilityForJobCard } from '@/lib/message-threads';

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
  // Email unless SMS is asked for — the same default and the same shape as the messaging centre's
  // compose box, so there is one way to say "by text" across the product.
  const channel: NotifyChannel = (req.body ?? {}).channel === 'sms' ? 'sms' : 'email';
  if (rawEmail && channel === 'sms') {
    return res.status(400).json({ message: 'An email address can’t be used for a text message.' });
  }

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, group_id: true,
      vehicle: { select: { registration: true } },
      customer: { select: { email: true } },
      group: { select: { group_name: true, trading_name: true, phone: true, billing: { select: { subscription_status: true, status: true } } } },
    },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You don’t have access to that job card.' });
  if (!canWrite({ subscriptionStatus: card.group.billing?.subscription_status ?? null, status: card.group.billing?.status ?? null })) {
    return res.status(402).json({ message: 'Your subscription is inactive — sharing is a write and is paused.' });
  }

  // ── THE RECIPIENT IS CHANNEL-SHAPED, AND RESOLVED THROUGH THE OWNERSHIP EDGE ────────────────
  // An explicit address still wins — staff sending to "the other half" is a real thing. Otherwise
  // reachabilityForJobCard answers it: it follows the ownership edge rather than the card's own
  // customer link (car-first re-root), and its refusal is already a sentence naming the customer
  // and the tab to fix it on, which beats "no customer email on this job card".
  const reach = rawEmail
    ? { ok: true as const, address: rawEmail.trim(), customerName: '' }
    : await reachabilityForJobCard(prisma, card.id, channel);
  if (!reach || !reach.ok) {
    return res.status(400).json({ message: reach?.reason ?? 'There is nobody to send this to — the vehicle has no current owner.' });
  }
  const recipient = reach.address;

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
    channel,
    groupId: card.group_id,
    subject: { type: 'job_card', id: card.id },
    data: {
      garageName,
      registration: card.vehicle?.registration ?? null,
      link: link.url,
      expiryDays: 14,
      // The one-way sender means a customer who replies gets nothing back, so every SMS carries the
      // garage's own number. Costs septets and is worth them — see lib/notification-templates.
      garagePhone: card.group.phone ?? null,
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
