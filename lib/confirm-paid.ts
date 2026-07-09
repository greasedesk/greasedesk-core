/**
 * File: lib/confirm-paid.ts
 * The clearance sweep: every paid_pending invoice whose window has elapsed is CONFIRMED
 * (paid_pending → paid, audited invoice.paid_confirmed, system actor) and its confirmation
 * receipt is sent through the ONE send path (garage BCC'd).
 *
 * CLAIM-FIRST idempotency: each row is flipped with a conditional updateMany keyed on
 * status='paid_pending' — a concurrent/second run claims 0 rows and no-ops, so a confirmation
 * can never double-send. An invoice unmarked during the window is no longer paid_pending and is
 * never touched. Send-after-claim failure leaves receipt_sent_at null → the invoice visibly
 * shows "receipt not sent" with a manual resend (auto-retry banked with the chaser rail).
 *
 * Called by /api/cron/confirm-paid (hourly Vercel Cron); `now` injectable for tests.
 */
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { sendInvoiceEmail } from '@/lib/invoice-email-send';

export type ConfirmSweepResult = { due: number; confirmed: number; sent: number; sendFailed: number };

export async function runConfirmPaidSweep(now: Date = new Date()): Promise<ConfirmSweepResult> {
  const due = (await prisma.invoice.findMany({
    where: { status: 'paid_pending', confirm_due_at: { lte: now } },
    select: { id: true, group_id: true, job_card_id: true, invoice_number: true },
  })) as Array<{ id: string; group_id: string; job_card_id: string; invoice_number: string | null }>;

  let confirmed = 0, sent = 0, sendFailed = 0;
  for (const inv of due) {
    try {
      // THE claim: flips only if still pending — second runs and unmarked invoices claim nothing.
      const claimed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const r = await tx.invoice.updateMany({ where: { id: inv.id, status: 'paid_pending' }, data: { status: 'paid' } });
        if (r.count !== 1) return false;
        await writeAudit(tx, {
          groupId: inv.group_id, userId: null, jobCardId: inv.job_card_id,
          action: 'invoice.paid_confirmed', diff: { number: inv.invoice_number, auto: true },
        });
        return true;
      });
      if (!claimed) continue;
      confirmed++;
      const res = await sendInvoiceEmail(inv.id, inv.group_id, null);
      if (res.ok) sent++;
      else { sendFailed++; console.error(`[confirm-paid] receipt send failed for ${inv.invoice_number}: ${res.code}`); }
    } catch (e) {
      console.error(`[confirm-paid] sweep error for invoice ${inv.id}:`, e);
    }
  }
  return { due: due.length, confirmed, sent, sendFailed };
}
