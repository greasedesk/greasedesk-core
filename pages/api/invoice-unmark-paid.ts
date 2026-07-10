/**
 * File: pages/api/invoice-unmark-paid.ts
 * Silent revert during the clearance window: POST { invoiceId }. paid_pending → issued — the
 * mark-paid was premature (bounced card, wrong card), NOTHING was sent to the customer, so this
 * is a lighter act than the ADMIN unlock (which reverses a CONFIRMED invoice whose receipt is
 * already in the world). Authority: manager/admin (canManageSite — same as mark-paid; STANDARD
 * blocked server-side). Drops the paid snapshot (the invoice renders live again), clears
 * paid_at/confirm_due_at, returns the card to `invoiced`. Audited invoice.paid_unmarked.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
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

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, status: true, invoice_number: true, site_id: true, job_card_id: true, job_card: { select: { status: true } } },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, invoice.site_id)) return res.status(403).json({ message: 'Only a manager or admin can make this change.' });
  if (invoice.status !== 'paid_pending') {
    return res.status(409).json({
      message: invoice.status === 'paid'
        ? 'This payment is already confirmed — an admin can unlock it instead.'
        : 'This invoice isn’t marked as paid.',
    });
  }

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // The claim mirrors the cron's: only flips if STILL pending, so a race with the sweep can't
      // both unmark and confirm the same invoice.
      const r = await tx.invoice.updateMany({
        where: { id: invoice.id, status: 'paid_pending' },
        data: { status: 'issued', paid_at: null, date_paid: null, confirm_due_at: null, payment_method_id: null, payment_method_snapshot: null },
      });
      if (r.count !== 1) throw new Error('RACE_LOST');
      await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } }); // drop the frozen snapshot
      if (invoice.job_card?.status === 'paid') {
        await tx.jobCard.update({ where: { id: invoice.job_card_id }, data: { status: 'invoiced' } });
      }
      await writeAudit(tx, {
        groupId: user.group_id as string, userId: user.id as string, jobCardId: invoice.job_card_id,
        action: 'invoice.paid_unmarked', diff: { number: invoice.invoice_number },
      });
    });
  } catch (e: any) {
    if (e?.message === 'RACE_LOST') return res.status(409).json({ message: 'This payment was just confirmed — an admin can unlock it instead.' });
    console.error('Invoice unmark-paid error:', e);
    return res.status(500).json({ message: 'Could not unmark the payment.' });
  }
  return res.status(200).json({ message: 'Payment unmarked.' });
}
