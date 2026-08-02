/**
 * File: pages/api/invoice-void.ts
 * ADMIN-ONLY. POST { invoiceId, category, reason } — retire an invoice issued in error.
 *
 * Deliberately mirrors pages/api/invoice-unlock.ts (same auth shape, same tenant scope, same
 * single-transaction write + audit) and deliberately differs from it in three ways, each of which
 * is a lesson from that endpoint:
 *
 *  1. IT DOES NOT TOUCH THE CARD. `unlock` hard-sets the job card to `invoiced` regardless of where
 *     it was, which silently un-cancels a cancelled card. A void says something about the DOCUMENT;
 *     it has no opinion about the job.
 *  2. IT REQUIRES FROZEN LINES. `unlock` leaves `issued` with zero lines — an empty husk. Voiding
 *     that would retain nothing, and retention is the whole point (VATREC5010).
 *  3. IT REQUIRES A REASON. See lib/invoice-void for why this is the exception to the standing
 *     "a mandatory field becomes a field full of x" rule.
 *
 * NOT IN THIS SLICE: the money reads still count a void (step 2), and nothing renders or re-sends
 * a void document yet. What IS here is every guard that stops a void being resurrected.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { writeAudit } from '@/lib/audit';
import { canVoid, isVoidCategory, validateVoidReason, VOID_CATEGORIES } from '@/lib/invoice-void';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId, category, reason } = (req.body || {}) as { invoiceId?: string; category?: string; reason?: string };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can void an invoice.' });

  if (!isVoidCategory(category)) {
    return res.status(400).json({ code: 'bad_category', message: `Pick why this is being voided (${VOID_CATEGORIES.join(', ')}).` });
  }
  const checked = validateVoidReason(reason);
  if (!checked.ok) return res.status(400).json({ code: 'bad_reason', message: checked.error });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, status: true, invoice_number: true, job_card_id: true, series: true, _count: { select: { lines: true } } },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  const allowed = canVoid({ status: invoice.status, lineCount: invoice._count.lines });
  if (!allowed.ok) return res.status(409).json({ code: allowed.code, message: allowed.message });

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // The number, the frozen lines and every snapshot stay exactly as they are. Only the status
      // and the explanation change — the document is retained, which is what makes the gap
      // acceptable to read. NOTE the absence of any jobCard update: see (1) in the header.
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status: 'void' as any,
          voided_at: new Date(),
          voided_by: user.id as string,
          void_category: category,
          void_reason: checked.value,
        },
      });
      await writeAudit(tx, {
        groupId: user.group_id as string,
        userId: user.id as string,
        jobCardId: invoice.job_card_id,
        action: 'invoice.voided',
        diff: { number: invoice.invoice_number, series: invoice.series, statusBefore: invoice.status, category, reason: checked.value },
      });
    });
  } catch (e) {
    console.error('Invoice void error:', e);
    return res.status(500).json({ message: 'Could not void the invoice.' });
  }
  return res.status(200).json({ message: `Invoice ${invoice.invoice_number} voided. The document and its number are retained.` });
}
