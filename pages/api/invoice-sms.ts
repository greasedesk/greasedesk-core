/**
 * File: pages/api/invoice-sms.ts
 * POST { invoiceId } → text the customer a link to pay this invoice.
 *
 * The SMS counterpart to /api/invoice-email, and deliberately NOT a channel argument on it: that
 * endpoint sends a DOCUMENT — the invoice email carries the PDF, the footer, the reply-to and the
 * garage BCC, none of which exist in a text. This sends a LINK. Same invoice, different artefact.
 *
 * ── ONE MINT, AND IT IS THIS ONE ────────────────────────────────────────────────────────────────
 * mintInvoicePayLink is the same call the email path makes, so the refusals come for free: a
 * receipt, a void, an unlocked invoice and a £0 document all return null and are refused here
 * rather than texting somebody a link to pay nothing. A text and an email sent separately are two
 * sends, so two links — that is one mint per send, which is what the rule means.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { buildInvoiceDoc } from '@/lib/invoice-doc';
import { balanceOwedPennies } from '@/lib/invoice';
import { mintInvoicePayLink } from '@/lib/invoice-pay-link';
import { reachabilityForJobCard } from '@/lib/message-threads';
import { sendNotification } from '@/lib/notify';
import { smsAllowance } from '@/lib/sms-allowance';
import { describeSendFailure, type FailedSend } from '@/lib/send-outcome';
import { formatMoney } from '@/lib/format-money';
import { writeAudit } from '@/lib/audit';
import { Prisma } from '@prisma/client';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const invoiceId = String((req.body ?? {}).invoiceId ?? '');
  const doc = await buildInvoiceDoc(invoiceId, user.group_id);
  if (!doc) return res.status(404).json({ message: 'Invoice not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, doc.siteId)) return res.status(403).json({ message: 'You do not have access to this invoice.' });

  const reach = await reachabilityForJobCard(prisma, doc.jobCardId, 'sms');
  if (!reach?.ok) return res.status(400).json({ message: reach?.reason ?? 'There is nobody to text — the vehicle has no current owner.' });

  const link = await mintInvoicePayLink({ doc, groupId: user.group_id, recipient: reach.address, createdByUserId: user.id });
  if (!link) {
    return res.status(409).json({ code: 'nothing_to_pay', message: 'There’s nothing to pay on this invoice, so there is no link to send.' });
  }

  const inv = (await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { amount_paid_pennies: true } })) as any;
  const total = doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies;
  const group = (await prisma.group.findUnique({ where: { id: user.group_id }, select: { group_name: true, trading_name: true, phone: true } })) as any;

  const sent = await sendNotification({
    recipient: reach.address,
    template: 'invoice_pay_link',
    channel: 'sms',
    groupId: user.group_id,
    subject: { type: 'invoice', id: invoiceId },
    sentByUserId: user.id,
    data: {
      garageName: group?.trading_name || group?.group_name || 'Your garage',
      number: doc.displayNumber,
      registration: doc.vehicle.reg ?? null,
      // The BALANCE, not the total — the same figure the customer view and the Pay button show.
      total: formatMoney(balanceOwedPennies(inv ?? {}, total), { currency: doc.currency, locale: doc.locale }),
      link: link.url,
      garagePhone: group?.phone ?? null,
    },
  });

  const allowance = await smsAllowance(prisma, user.group_id);
  if (!sent.ok) {
    // ONE MAPPING, shared with quote-send. The catch-all here used to be:
    //     "The text couldn’t be sent — please try again shortly."
    // for every cause it did not name — advice that is simply false for a demo tenant, an
    // opted-out customer or an unconfigured provider. Retrying those repeats the same refusal.
    const why = describeSendFailure(sent as FailedSend, { channel: 'sms', customerName: reach.customerName });
    // Caller-specific advice, appended rather than folded in: the shared mapping states the cause,
    // this states what THIS screen can do about it.
    const advice = why.code === 'allowance_spent' ? ' Top up, or email the invoice instead.'
      : why.retryable ? ' Please try again shortly.'
      : '';
    // THE STATUS FOLLOWS THE FACT. 502 says an upstream failed and is only true when one did.
    return res.status(why.retryable ? 502 : 409)
      .json({ code: why.code, retryable: why.retryable, message: `${why.message} Nothing was sent.${advice}`, allowance });
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await writeAudit(tx, {
      groupId: user.group_id, userId: user.id, jobCardId: doc.jobCardId, action: 'invoice.sent',
      diff: { number: doc.number, to: reach.address, channel: 'sms', payLink: true },
    });
  });
  return res.status(200).json({ ok: true, allowance });
}
