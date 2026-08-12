/**
 * File: pages/api/invoice-unlock.ts
 * ADMIN-ONLY escape hatch under FREEZE-AT-ISSUE. POST { invoiceId, action? }.
 *  action 'unlock' (default): paid → issued (clears payment grain) OR settled → issued (warranty);
 *    DELETES the frozen lines — their absence IS the unlocked/editable state — and reverts the
 *    card to `invoiced`. While unlocked the invoice contributes NOTHING to the ledger (visible,
 *    honest "under correction"). Fully audited (invoice.unlocked).
 *  action 'reissue': re-freeze and re-lock — warranty lands back at `settled`; chargeable stays
 *    `issued` (or re-pay re-freezes instead). Audited (invoice.reissued).
 *
 *    IT RE-SNAPSHOTS THE AGREED QUOTE VERSION, NOT "THE CORRECTED CARD LINES". This docstring said
 *    the latter for months and the code never did it: snapshotInvoiceLines resolves to the accepted
 *    QuoteVersion whenever one exists, so on an accepted card a re-issue reproduces the agreed
 *    figure however the estimate has since been edited. The gap between the two sentences is how
 *    invoice 100003203 survived four unlock/re-issue cycles still missing £75 of real work — the
 *    button reported success every time. Corrected here rather than left to mislead the next reader.
 *
 *    Where the two now genuinely differ, the re-issue REFUSES and names both figures
 *    (lib/invoice-issue::reissueDivergence). Billing work nobody agreed to is not the fix; telling
 *    the garage what to do about it is.
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

import { tServer } from '@/lib/server-i18n';
import { refuseIfVoid, refuseIfSent } from '@/lib/invoice-void';
import { snapshotInvoiceLines, reissueDivergence } from '@/lib/invoice-issue';

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
    select: { id: true, status: true, series: true, invoice_number: true, job_card_id: true, receipt_sent_at: true, vat_registered_at_issue: true, job_card: { select: { status: true } }, lines: { select: { id: true }, take: 1 }, site: { select: { locale: true } } },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  // THE SHARP EDGE. `reissue` gates on the ABSENCE of lines, and this guard sits ABOVE that gate on
  // purpose: a void keeps its lines, so it would fail the no-lines check for the right reason
  // today — but the moment anyone unlocks-then-voids, or the precondition changes, re-issue would
  // read a void as "unlocked, ready to re-freeze" and silently revive a retired document.
  // Guarding on the status, above both branches, is the version of this that cannot rot.
  const voided = refuseIfVoid(invoice);
  if (voided) return res.status(409).json(voided);

  // ALREADY WITH THE CUSTOMER → refuse BOTH branches (ruling 2026-08-08). unlock deletes the frozen
  // lines and reissue re-freezes them under the SAME number, so between them they could rebuild a
  // document the customer is holding into a different one with the same reference and no trace on
  // their copy. Guarded above both branches for the same reason the void guard is: a check that sits
  // inside one branch protects only that branch.
  const sentAudit = await prisma.auditLog.findFirst({
    where: { entity_id: invoice.job_card_id, action: 'invoice.sent' },
    select: { id: true },
  });
  const sent = refuseIfSent(invoice, !!sentAudit);
  if (sent) return res.status(409).json(sent);

  if (act === 'reissue') {
    // Re-freeze the corrected card lines and re-lock. Only meaningful while unlocked (no lines).
    if (invoice.lines.length > 0) return res.status(409).json({ message: 'This invoice is already frozen — unlock it first to make corrections.' });

    // ── REFUSE RATHER THAN SILENTLY REPRODUCE THE OLD FIGURE ─────────────────────────────────
    // Checked BEFORE the transaction: the point is that nothing happens, and an admin who has just
    // edited an estimate is told why instead of being congratulated on a no-op.
    const diverged = await reissueDivergence(prisma, invoice);
    if (diverged) {
      const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
      return res.status(409).json({
        code: 'estimate_diverged',
        agreedPennies: diverged.agreedPennies,
        livePennies: diverged.livePennies,
        message: `The estimate now totals ${gbp(diverged.livePennies)} but the agreed quote (version ${diverged.version}) is ${gbp(diverged.agreedPennies)}. An invoice can only bill what the customer agreed to, so re-issuing would reproduce ${gbp(diverged.agreedPennies)} unchanged. Re-quote the difference and record the customer's agreement, then re-issue.`,
      });
    }
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
      // A REFUSAL, not a crash: surface the real reason. Swallowing this into a generic 500 is how
      // "Failed to update status." masked a three-figure explanation of why a freeze was refused.
      if (String((e as any)?.message ?? '').startsWith('IMPORT_ASSERT:')) {
        return res.status(409).json({ message: String((e as any).message).slice('IMPORT_ASSERT:'.length) });
      }
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
