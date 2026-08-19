/**
 * File: pages/api/intake-report-send.ts
 * SEND THE INTAKE REPORT — POST { jobCardId, channel: 'sms' | 'email' }.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────
 * It does not freeze anything. A quote has a version because it names a price; a report names none,
 * so there is nothing to freeze and nothing to supersede. The link opens the CURRENT state of the
 * car's findings — a finding closed after sending simply stops appearing, which is correct: the
 * customer should not be answering something the garage has already dealt with.
 *
 * ── AND IT DOES NOT REVOKE THE OLD LINK ─────────────────────────────────────────────────────────
 * Unlike a quote, where a superseded version MUST kill its link (a customer accepting a stale price
 * is the worst case). Re-sending a report is a nudge, and a customer who kept the first message
 * should still be able to answer from it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { createMagicLink, MAGIC_LINK_DAYS } from '@/lib/magic-link';
import { sendNotification } from '@/lib/notify';
import { reachabilityForJobCard } from '@/lib/message-threads';
import { describeSendFailure, type FailedSend } from '@/lib/send-outcome';
import { resolveContactRoutes } from '@/lib/contact-routes';
import { openDueItemsForVehicle } from '@/lib/due-items';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  const { jobCardId, channel } = (req.body || {}) as { jobCardId?: string; channel?: 'sms' | 'email' };
  if (!jobCardId || (channel !== 'sms' && channel !== 'email')) {
    return res.status(400).json({ message: 'A job card and a channel are required.' });
  }

  const card = (await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: groupId },
    select: {
      id: true, site_id: true, vehicle_id: true,
      vehicle: { select: { registration: true } },
      site: { select: { phone: true } },
      group: { select: { group_name: true, trading_name: true, phone: true } },
    },
  })) as any;
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const reach = await reachabilityForJobCard(prisma, card.id, channel);
  const recipient = reach?.ok ? reach.address.trim() : '';
  const findings = await openDueItemsForVehicle(prisma, groupId, card.vehicle_id);

  const link = await createMagicLink({
    groupId, jobCardId: card.id, purpose: 'intake_report',
    recipient: recipient || '(no address — link handed over)',
    createdByUserId: user.id as string,
  });

  const garageName = card.group?.trading_name || card.group?.group_name || 'Your garage';
  let sent = false; let refusal: string | null = null; let refusalCode: string | null = null; let retryable = false;

  if (recipient) {
    const r = await sendNotification({
      recipient, template: 'intake_report', channel, groupId,
      subject: { type: 'job_card', id: card.id },
      data: {
        garageName,
        garagePhone: resolveContactRoutes(card.site, card.group).phone,
        registration: card.vehicle?.registration ?? null,
        findingCount: findings.length,
        link: link.url,
        expiryDays: MAGIC_LINK_DAYS,
      },
    });
    sent = r.ok;
    if (!r.ok) {
      // THE THREE SILENCES, named (lib/send-outcome). A garage that thinks a customer is ignoring
      // them, when the send never left, is the exact failure that mapping exists to prevent.
      const why = describeSendFailure(r as FailedSend, {
        channel, customerName: reach && 'customerName' in reach ? reach.customerName : null,
      });
      refusal = `${why.message} The link below still works.`;
      refusalCode = why.code; retryable = why.retryable;
    }
  } else {
    // NO ADDRESS is its own silence and must not read as a failed send — nothing was attempted.
    refusal = `${reach && !reach.ok ? reach.reason : 'There is nobody to send to on this card.'} The link below still works.`;
    refusalCode = 'no_recipient';
  }

  await writeAudit(prisma as never, {
    groupId, userId: user.id as string, jobCardId: card.id,
    action: 'intake_report.sent',
    diff: { channel, sent, sentTo: recipient || null, findingCount: findings.length, refusalCode },
  });

  return res.status(200).json({
    ok: true, sent, channel, sentTo: recipient || null,
    url: link.url, expiresAt: link.expiresAt.toISOString(), expiryDays: MAGIC_LINK_DAYS,
    findingCount: findings.length, refusal, refusalCode, retryable,
  });
}
