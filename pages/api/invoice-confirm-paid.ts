/**
 * File: pages/api/invoice-confirm-paid.ts
 * Manual confirmation: POST { invoiceId } — "the money actually arrived." For manual-method
 * invoices this is the ONLY way they confirm (the cron never touches confirm_due_at = NULL);
 * for windowed ones it's an early confirm. Manager/admin (same authority as mark-paid),
 * CLAIM-FIRST like the cron (a race can't double-confirm), audited invoice.paid_confirmed
 * (human actor, manual:true), receipt through the ONE send path.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { sendInvoiceEmail } from '@/lib/invoice-email-send';

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
    select: { id: true, status: true, site_id: true, job_card_id: true, invoice_number: true, payment_method_snapshot: true },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, invoice.site_id)) return res.status(403).json({ message: 'Only a manager or admin can make this change.' });
  if (invoice.status !== 'paid_pending') {
    return res.status(409).json({ message: invoice.status === 'paid' ? 'This payment is already confirmed.' : 'This invoice isn’t marked as paid.' });
  }

  try {
    const claimed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const r = await tx.invoice.updateMany({ where: { id: invoice.id, status: 'paid_pending' }, data: { status: 'paid' } });
      if (r.count !== 1) return false; // raced the cron — it confirmed first, fine
      await writeAudit(tx, {
        groupId: user.group_id as string, userId: user.id as string, jobCardId: invoice.job_card_id,
        action: 'invoice.paid_confirmed', diff: { number: invoice.invoice_number, method: invoice.payment_method_snapshot, manual: true },
      });
      return true;
    });
    if (!claimed) return res.status(200).json({ message: 'Payment confirmed.' }); // already confirmed by the sweep
  } catch (e) {
    console.error('Invoice confirm-paid error:', e);
    return res.status(500).json({ message: 'Could not confirm the payment.' });
  }
  try { await sendInvoiceEmail(invoice.id, user.group_id as string, user.id as string); }
  catch (e) { console.error('confirm receipt send failed:', e); } // visible "receipt not sent" state covers it
  return res.status(200).json({ message: 'Payment confirmed.' });
}
