/**
 * File: pages/api/invoice-unlock.ts
 * ADMIN-ONLY escape hatch: unlock a PAID invoice for correction. POST { invoiceId }.
 * paid → issued: clears paid_at, drops the paid snapshot (the invoice goes back to rendering the
 * card's live lines), and reverts the card's status to `invoiced` so the normal re-pay path
 * re-freezes it. Fully audited (invoice.unlocked, actor + number in the diff).
 * Credit notes are the accounting-correct path for larger corrections — they arrive later and
 * slot in beside this, not through it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId } = (req.body || {}) as { invoiceId?: string };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can unlock a paid invoice.' });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, status: true, invoice_number: true, job_card_id: true, job_card: { select: { status: true } } },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
  if (invoice.status !== 'paid') {
    return res.status(409).json({
      message: invoice.status === 'paid_pending'
        ? 'This payment is still pending confirmation — unmark it instead (no unlock needed; nothing has been sent).'
        : 'This invoice isn’t locked — it’s already editable.',
    });
  }

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } }); // drop the paid snapshot
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'issued', paid_at: null, date_paid: null, receipt_sent_at: null, payment_method_id: null, payment_method_snapshot: null } });
      // Card rejoins the spine at `invoiced` (from paid or done) so re-pay re-freezes normally.
      await tx.jobCard.update({ where: { id: invoice.job_card_id }, data: { status: 'invoiced' } });
      await writeAudit(tx, {
        groupId: user.group_id as string,
        userId: user.id as string,
        jobCardId: invoice.job_card_id,
        action: 'invoice.unlocked',
        diff: { number: invoice.invoice_number, cardStatusBefore: invoice.job_card?.status },
      });
    });
  } catch (e) {
    console.error('Invoice unlock error:', e);
    return res.status(500).json({ message: 'Could not unlock the invoice.' });
  }
  return res.status(200).json({ message: 'Invoice unlocked.' });
}
