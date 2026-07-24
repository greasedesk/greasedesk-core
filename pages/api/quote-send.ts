/**
 * File: pages/api/quote-send.ts
 * POST { jobCardId, email? } → freeze the estimate as a new QuoteVersion, mint a magic link for it,
 * and email it. THE one path a quote reaches a customer.
 *
 * COPYABLE LINK, ALWAYS. The URL comes back in the response whether or not the email went, so staff
 * can pass it on by hand (WhatsApp, read out over the phone). A customer with NO email address is
 * not blocked: we mint the link, skip the send, and return it — the same "offer the link rather than
 * fail" pattern as the operator-invite dev fallback. `emailed` tells the UI which happened.
 *
 * Freezing and revoking happen through lib/quote-version, sending through lib/notify, the credential
 * through lib/magic-link — this route orchestrates chokepoints, it does not reimplement any of them.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { canWrite } from '@/lib/billing';
import { createMagicLink, MAGIC_LINK_DAYS, revokeMagicLinksForCard } from '@/lib/magic-link';
import { sendNotification } from '@/lib/notify';
import { freezeQuoteVersion, attachMagicLink } from '@/lib/quote-version';
import { formatMoney } from '@/lib/format-money';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, email: rawEmail } = (req.body ?? {}) as Record<string, string>;
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, group_id: true, status: true,
      vehicle: { select: { registration: true } },
      customer: { select: { email: true } },
      group: {
        select: {
          group_name: true, trading_name: true, tax_label: true, vat_registered: true,
          billing: { select: { subscription_status: true, status: true } },
        },
      },
      site: { select: { currency_code: true, locale: true } },
      _count: { select: { items: true } },
    },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You don’t have access to that job card.' });
  if (!canWrite({ subscriptionStatus: card.group.billing?.subscription_status ?? null, status: card.group.billing?.status ?? null })) {
    return res.status(402).json({ message: 'Your subscription is inactive — sending a quote is paused.' });
  }
  if (!card._count.items) return res.status(400).json({ message: 'Add at least one line to the estimate before sending it.' });

  // A NEW send supersedes anything already out AND kills its link, before the new one exists — an
  // old set of figures must never be acceptable once a newer offer has been made.
  await revokeMagicLinksForCard(card.id);

  let frozen;
  try {
    frozen = await freezeQuoteVersion({
      groupId: card.group_id,
      jobCardId: card.id,
      createdByUserId: user.id as string,
      vatRegistered: !!card.group.vat_registered,
      taxLabel: card.group.tax_label || 'VAT',
    });
  } catch (e: any) {
    if (e?.message === 'NO_LINES') return res.status(400).json({ message: 'Add at least one line to the estimate before sending it.' });
    throw e;
  }

  const recipient = (rawEmail || card.customer?.email || '').trim();
  const link = await createMagicLink({
    groupId: card.group_id,
    jobCardId: card.id,
    purpose: 'quote_view',
    recipient: recipient || '(no email — link handed over)',
    createdByUserId: user.id as string,
  });
  await attachMagicLink(frozen.id, link.id, recipient || null);

  const garageName = card.group.trading_name || card.group.group_name || 'Your garage';
  let emailed = false;
  let deliveryStatus: string = 'not_attempted';
  let notificationId: string | null = null;

  if (recipient) {
    const sent = await sendNotification({
      recipient,
      template: 'quote_ready',
      channel: 'email',
      groupId: card.group_id,
      subject: { type: 'job_card', id: card.id },
      data: {
        garageName,
        registration: card.vehicle?.registration ?? null,
        total: formatMoney(frozen.grossPennies, { currency: card.site?.currency_code ?? 'GBP', locale: card.site?.locale ?? 'en-GB' }),
        link: link.url,
        expiryDays: MAGIC_LINK_DAYS,
      },
    });
    emailed = sent.ok;
    deliveryStatus = sent.status;
    notificationId = sent.notificationId;
  }

  // The card becomes `quoted` on the first send; a later send doesn't drag it backwards from a
  // further-on status (2b owns the accepted transition).
  if (card.status === 'draft') {
    await prisma.jobCard.update({ where: { id: card.id }, data: { status: 'quoted' } }).catch(() => {});
  }

  await writeAudit(prisma, {
    groupId: card.group_id,
    userId: user.id as string,
    jobCardId: card.id,
    action: 'quote.sent',
    diff: {
      version: frozen.version,
      lines: frozen.lineCount,
      grossPennies: frozen.grossPennies,
      emailed,
      sentTo: recipient || null,
      handedOver: !recipient, // no address on file — the link was offered instead of a send
    },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    version: frozen.version,
    quoteVersionId: frozen.id,
    url: link.url,            // ALWAYS returned — copyable by hand
    expiresAt: link.expiresAt.toISOString(),
    expiryDays: MAGIC_LINK_DAYS,
    emailed,
    sentTo: recipient || null,
    deliveryStatus,
    notificationId,
    totals: { netPennies: frozen.netPennies, vatPennies: frozen.vatPennies, grossPennies: frozen.grossPennies },
  });
}
