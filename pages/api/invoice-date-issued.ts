/**
 * File: pages/api/invoice-date-issued.ts
 * POST { invoiceId, dateIssued: 'yyyy-mm-dd' } — edit the DOCUMENT's issue/billing date (defaults
 * from mint). Mirrors invoice-date-paid: manager/admin only, audited invoice.date_issued_edited
 * with from/to (it's a financial fact — the P&L recognises revenue by this date). Guardrails:
 * not in the future, not before the job's booked date. issued_at (the mint attestation) is never
 * touched here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { writeAudit } from '@/lib/audit';
import { validateIssueDate } from '@/lib/invoice';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId, dateIssued } = (req.body || {}) as { invoiceId?: string; dateIssued?: string };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });
  const ds = String(dateIssued || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return res.status(400).json({ message: 'The issue date must be a valid date.' });
  const d = new Date(`${ds}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'The issue date must be a valid date.' });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: {
      id: true, status: true, site_id: true, job_card_id: true, invoice_number: true,
      date_issued: true, issued_at: true,
      job_card: { select: { start_at: true } },
    },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, invoice.site_id)) return res.status(403).json({ message: 'Only a manager or admin can make this change.' });

  const bad = validateIssueDate(d, invoice.job_card?.start_at ?? null, new Date());
  if (bad === 'future') return res.status(400).json({ message: 'The issue date can’t be in the future.' });
  if (bad === 'beforeJob') return res.status(400).json({ message: 'The issue date can’t be before the job’s date.' });

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.invoice.update({ where: { id: invoice.id }, data: { date_issued: d } });
      await writeAudit(tx, {
        groupId: user.group_id as string, userId: user.id as string, jobCardId: invoice.job_card_id,
        action: 'invoice.date_issued_edited',
        diff: {
          number: invoice.invoice_number,
          from: invoice.date_issued ? new Date(invoice.date_issued).toISOString().slice(0, 10) : new Date(invoice.issued_at).toISOString().slice(0, 10),
          to: ds,
        },
      });
    });
  } catch (e) {
    console.error('Invoice date-issued error:', e);
    return res.status(500).json({ message: 'Could not save the issue date.' });
  }
  return res.status(200).json({ message: 'Issue date saved.' });
}
