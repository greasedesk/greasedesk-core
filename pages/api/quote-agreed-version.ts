/**
 * File: pages/api/quote-agreed-version.ts
 * POST { jobCardId, versionId } → record that the customer agreed a LATER quote version, on a card
 * already invoiced against an earlier one. ADMIN ONLY.
 *
 * Its ONLY purpose is to correct an invoice, so its authority matches the correction it enables:
 * unlock/re-issue is admin-only, and a manager-level acceptance feeding an admin-level correction
 * would be a route for laundering authority.
 *
 * TWO STEPS, NOT ONE (ruling 2026-08-08). This records the agreement and nothing else. The admin
 * then unlocks and re-issues, which is a separate audited act. Fusing them would hide a change to
 * what a customer owes inside a click labelled "accepted".
 *
 * The card status is NOT checked — that is the whole point, and why this calls recordAgreedVersion
 * rather than acceptQuote. Everything else is checked harder than the normal path:
 * paid, void, ALREADY SENT, no invoice at all, and the version must still be the open offer.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { recordAgreedVersion, isAgreedVersionRefusal } from '@/lib/quote-acceptance';
import { refuseIfVoid, refuseIfSent } from '@/lib/invoice-void';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, versionId } = (req.body ?? {}) as { jobCardId?: string; versionId?: string };
  if (!jobCardId || !versionId) return res.status(400).json({ message: 'jobCardId and versionId are required.' });

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, site_id: true, group_id: true, status: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can record an agreed version on an invoiced job.' });
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You don’t have access to that job card.' });

  // THE INVOICE IS THE PRECONDITION, not an afterthought: this path exists only to correct one. With
  // no invoice the ordinary verbal control applies, and sending the admin there is a better answer
  // than quietly doing something subtly different.
  const invoice = (await prisma.invoice.findUnique({
    where: { job_card_id: card.id },
    select: { id: true, status: true, invoice_number: true, receipt_sent_at: true },
  })) as { id: string; status: string; invoice_number: string | null; receipt_sent_at: Date | null } | null;
  if (!invoice) {
    return res.status(409).json({
      code: 'no_invoice',
      message: 'This job has no invoice, so there is nothing to correct — use “Mark accepted (customer confirmed by phone)” on the Quote step instead.',
    });
  }

  const voided = refuseIfVoid(invoice);
  if (voided) return res.status(409).json(voided);

  // MONEY HAS MOVED → a different conversation. Unmark the payment first if it was recorded wrongly.
  if (invoice.status === 'paid' || invoice.status === 'paid_pending') {
    return res.status(409).json({
      code: 'already_paid',
      message: 'This invoice has been paid, so its lines can no longer change. Unmark the payment first if it was recorded in error.',
    });
  }

  // ALREADY WITH THE CUSTOMER → refuse. `invoice.sent` is audited against the JOB CARD (see
  // lib/invoice-void.refuseIfSent), which is unambiguous because a card has at most one invoice.
  const sentAudit = await prisma.auditLog.findFirst({
    where: { entity_id: card.id, action: 'invoice.sent' },
    select: { id: true },
  });
  const sent = refuseIfSent(invoice, !!sentAudit);
  if (sent) return res.status(409).json(sent);

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) =>
    recordAgreedVersion(tx, {
      groupId: card.group_id,
      jobCardId: card.id,
      versionId,
      actorUserId: user.id as string,
      at: new Date(),
    }),
  );
  if (isAgreedVersionRefusal(result)) return res.status(409).json(result);

  return res.status(200).json({
    ok: true,
    version: result.version,
    grossPennies: result.grossPennies,
    // The next step is stated, because this deliberately did not take it.
    message: `Recorded that the customer agreed version ${result.version}. This is logged as a garage-recorded agreement. Invoice ${invoice.invoice_number} still shows the earlier figures — unlock and re-issue it to correct them.`,
  });
}
