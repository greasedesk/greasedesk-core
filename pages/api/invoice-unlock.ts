/**
 * File: pages/api/invoice-unlock.ts
 * ADMIN-ONLY escape hatch under FREEZE-AT-ISSUE. POST { invoiceId, action? }.
 *  action 'unlock' (default): paid → issued (clears payment grain) OR settled → issued (warranty);
 *    DELETES the frozen lines — their absence IS the unlocked/editable state — and reverts the
 *    card to `invoiced`. While unlocked the invoice contributes NOTHING to the ledger (visible,
 *    honest "under correction"). Fully audited (invoice.unlocked).
 *  action 'reissue': re-snapshot the corrected card lines (idempotent freeze) and re-lock —
 *    warranty lands back at `settled`; chargeable stays `issued` (or re-pay re-freezes instead).
 *    Audited (invoice.reissued).
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
import { snapshotInvoiceLines } from '@/lib/invoice-issue';
import { tServer } from '@/lib/server-i18n';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId, action } = (req.body || {}) as { invoiceId?: string; action?: 'unlock' | 'reissue' };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });
  const act = action === 'reissue' ? 'reissue' : 'unlock';

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can unlock or re-issue an invoice.' });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, status: true, series: true, invoice_number: true, job_card_id: true, vat_registered_at_issue: true, job_card: { select: { status: true } }, lines: { select: { id: true }, take: 1 }, site: { select: { locale: true } } },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  if (act === 'reissue') {
    // Re-freeze the corrected card lines and re-lock. Only meaningful while unlocked (no lines).
    if (invoice.lines.length > 0) return res.status(409).json({ message: 'This invoice is already frozen — unlock it first to make corrections.' });
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await snapshotInvoiceLines(tx, invoice, {
          goodwill: tServer(invoice.site?.locale, 'invoice', 'warrantyGoodwill'),
          noCharge: tServer(invoice.site?.locale, 'invoice', 'warrantyLine'),
        });
        if (invoice.series === 'warranty') {
          await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'settled' as any } }); // back to terminal
        }
        await writeAudit(tx, {
          groupId: user.group_id as string, userId: user.id as string, jobCardId: invoice.job_card_id,
          action: 'invoice.reissued', diff: { number: invoice.invoice_number },
        });
      });
    } catch (e) {
      console.error('Invoice re-issue error:', e);
      return res.status(500).json({ message: 'Could not re-issue the invoice.' });
    }
    return res.status(200).json({ message: 'Invoice re-issued — corrections are frozen.' });
  }

  // unlock: paid → issued, settled → issued (warranty), or issued-with-frozen-lines → unlocked.
  // Only pending (unmark instead) and already-unlocked invoices reject.
  if (invoice.status === 'paid_pending') {
    return res.status(409).json({ message: 'This payment is still pending confirmation — unmark it instead (no unlock needed; nothing has been sent).' });
  }
  if (invoice.status === 'issued' && invoice.lines.length === 0) {
    return res.status(409).json({ message: 'This invoice is already unlocked — correct the estimate, then re-issue it.' });
  }

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Drop the frozen snapshot — the absence of lines IS the unlocked/editable state. While
      // unlocked the invoice contributes nothing to the ledger (honest "under correction").
      await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } });
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'issued', paid_at: null, date_paid: null, receipt_sent_at: null, payment_method_id: null, payment_method_snapshot: null } });
      // Card rejoins the spine at `invoiced` so re-issue / re-pay re-freezes normally.
      await tx.jobCard.update({ where: { id: invoice.job_card_id }, data: { status: 'invoiced' } });
      await writeAudit(tx, {
        groupId: user.group_id as string,
        userId: user.id as string,
        jobCardId: invoice.job_card_id,
        action: 'invoice.unlocked',
        diff: { number: invoice.invoice_number, statusBefore: invoice.status, cardStatusBefore: invoice.job_card?.status },
      });
    });
  } catch (e) {
    console.error('Invoice unlock error:', e);
    return res.status(500).json({ message: 'Could not unlock the invoice.' });
  }
  return res.status(200).json({ message: 'Invoice unlocked — correct the estimate, then re-issue (or re-pay) to freeze it again.' });
}
