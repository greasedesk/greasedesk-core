/**
 * File: pages/api/invoice-date-paid.ts
 * POST { invoiceId, datePaid: 'yyyy-mm-dd' } — edit the DOCUMENT's paid date (defaults from
 * mark-paid). Manager/admin only, invoice must be in the paid family (pending or confirmed),
 * audited invoice.date_paid_edited with from/to (it's a financial fact on a document).
 * paid_at (the attestation timestamp) is never touched here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { validatePaymentDate, effectiveIssueDate } from '@/lib/invoice';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId, datePaid } = (req.body || {}) as { invoiceId?: string; datePaid?: string };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });
  const ds = String(datePaid || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return res.status(400).json({ message: 'The paid date must be a valid date.' });
  const d = new Date(`${ds}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'The paid date must be a valid date.' });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, status: true, site_id: true, job_card_id: true, invoice_number: true, date_paid: true, date_issued: true, issued_at: true },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, invoice.site_id)) return res.status(403).json({ message: 'Only a manager or admin can make this change.' });
  if (invoice.status !== 'paid' && invoice.status !== 'paid_pending') {
    return res.status(409).json({ message: 'This invoice isn’t marked as paid yet.' });
  }
  // Guardrails: a payment can't precede the invoice's (effective) issue date or sit in the future.
  const badPaid = validatePaymentDate(d, effectiveIssueDate(invoice), new Date());
  if (badPaid === 'future') return res.status(400).json({ message: 'The paid date can’t be in the future.' });
  if (badPaid === 'beforeIssue') return res.status(400).json({ message: 'The paid date can’t be before the invoice’s issue date.' });

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.invoice.update({ where: { id: invoice.id }, data: { date_paid: d } });
      await writeAudit(tx, {
        groupId: user.group_id as string, userId: user.id as string, jobCardId: invoice.job_card_id,
        action: 'invoice.date_paid_edited',
        diff: { number: invoice.invoice_number, from: invoice.date_paid ? new Date(invoice.date_paid).toISOString().slice(0, 10) : null, to: ds },
      });
    });
  } catch (e) {
    console.error('Invoice date-paid error:', e);
    return res.status(500).json({ message: 'Could not save the paid date.' });
  }
  return res.status(200).json({ message: 'Paid date saved.' });
}
