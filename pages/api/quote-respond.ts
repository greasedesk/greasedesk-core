/**
 * File: pages/api/quote-respond.ts
 * POST { token, action: 'accept' | 'decline' } — the CUSTOMER's answer to a quote.
 *
 * AUTHENTICATED BY THE MAGIC LINK ALONE. There is no session: the token IS the credential
 * (lib/magic-link states that trade plainly). Which is exactly why the answer is recorded at
 * AUDIT GRADE — WHICH QuoteVersion, WHEN, from WHAT IP and WHAT user-agent — the same weight as the
 * rep agreement's click-sign. If the price is disputed later, the accepted version is frozen and the
 * acceptance is attributable.
 *
 * Bounded by design, per the magic-link rule: this endpoint moves no money and destroys nothing. It
 * writes one decision onto one version, flips one card status, and notifies the garage.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { resolveMagicLink, revokeMagicLinksForCard } from '@/lib/magic-link';
import { clientIp } from '@/lib/auth-rate-limit';
import { sendNotification } from '@/lib/notify';
import { formatMoney } from '@/lib/format-money';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const { token, action } = (req.body ?? {}) as { token?: string; action?: string };
  if (!token || (action !== 'accept' && action !== 'decline')) {
    return res.status(400).json({ message: 'A token and an action (accept or decline) are required.' });
  }

  const ip = clientIp(req.headers as any);
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 500);

  const resolved = await resolveMagicLink(token, { purpose: 'quote_view', ip, recordUse: false });
  if (!resolved.ok) {
    const code = resolved.reason === 'expired' ? 410 : resolved.reason === 'rate_limited' ? 429 : 404;
    return res.status(code).json({ message: 'This quote link is no longer valid.', reason: resolved.reason });
  }

  const version = await prisma.quoteVersion.findFirst({
    where: { job_card_id: resolved.link.jobCardId, magic_link_id: resolved.link.id },
    select: { id: true, version: true, status: true, gross_pennies: true, group_id: true },
  });
  if (!version) return res.status(404).json({ message: 'This quote is no longer available.' });

  // Already answered → idempotent, not an error. A customer double-tapping "Accept" on a flaky
  // phone connection must not see a failure for something that already worked.
  if (version.status === 'accepted' || version.status === 'declined') {
    return res.status(200).json({ ok: true, already: true, outcome: version.status, version: version.version });
  }
  if (version.status === 'superseded') {
    return res.status(409).json({ message: 'This quote has been replaced by a newer one.', reason: 'superseded' });
  }

  const card = await prisma.jobCard.findUnique({
    where: { id: resolved.link.jobCardId },
    select: {
      id: true, group_id: true, status: true,
      customer: { select: { name: true } },
      vehicle: { select: { registration: true } },
      site: { select: { currency_code: true, locale: true } },
      group: { select: { group_name: true, trading_name: true, billing_email: true } },
    },
  });
  if (!card) return res.status(404).json({ message: 'This quote is no longer available.' });

  const now = new Date();
  const accepted = action === 'accept';

  await prisma.$transaction(async (tx: any) => {
    // THE audit-grade record: version + when + from where + with what.
    await tx.quoteVersion.update({
      where: { id: version.id },
      data: {
        status: accepted ? 'accepted' : 'declined',
        responded_at: now,
        responded_ip: ip,
        responded_user_agent: ua,
      },
    });
    // Accepting moves the card on. Declining leaves the card where it is (the garage decides what
    // to do next) but the offer is closed.
    if (accepted && (card.status === 'quoted' || card.status === 'draft')) {
      await tx.jobCard.update({ where: { id: card.id }, data: { status: 'accepted' } });
    }
    await writeAudit(tx, {
      groupId: card.group_id,
      userId: null, // the CUSTOMER acted, not a staff user — attribution is the ip/ua on the version
      jobCardId: card.id,
      action: accepted ? 'quote.accepted' : 'quote.declined',
      diff: { version: version.version, grossPennies: version.gross_pennies, at: now.toISOString(), ip, userAgent: ua },
    });
  });

  // A DECLINE ends the link — the offer is over. An ACCEPT deliberately leaves it live so the
  // customer can re-open what they agreed to.
  if (!accepted) await revokeMagicLinksForCard(card.id).catch(() => {});

  const garageName = card.group.trading_name || card.group.group_name || 'your garage';
  const total = formatMoney(version.gross_pennies, { currency: card.site?.currency_code ?? 'GBP', locale: card.site?.locale ?? 'en-GB' });
  await sendNotification({
    recipient: card.group.billing_email,
    template: accepted ? 'quote_accepted' : 'quote_declined',
    channel: 'email',
    groupId: card.group_id,
    subject: { type: 'job_card', id: card.id },
    data: {
      garageName,
      customerName: card.customer?.name ?? 'The customer',
      registration: card.vehicle?.registration ?? null,
      version: version.version,
      total,
      when: now.toLocaleString(card.site?.locale ?? 'en-GB'),
      link: `${process.env.NEXT_PUBLIC_APP_URL || 'https://greasedesk.com'}/admin/jobcards/${card.id}`,
    },
  });

  return res.status(200).json({ ok: true, outcome: accepted ? 'accepted' : 'declined', version: version.version });
}
