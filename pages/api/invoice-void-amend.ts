/**
 * File: pages/api/invoice-void-amend.ts
 * ADMIN-ONLY. POST { invoiceId, reason } — improve the wording of a void reason.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The reason is the record that explains a gap in the sequential series (VATREC5010). A reason that
 * does not explain — TMBS 100003186 was voided with the words "Test Invoice" — fails the only job
 * the field has. It must therefore be improvable. It must NOT be quietly rewritable.
 *
 * ── A GUARDED EXCEPTION, NOT AN UNLOCK ──────────────────────────────────────────────────────────
 * This is the ONLY write path that accepts a voided invoice, and it is narrow by construction:
 *   - it REQUIRES status === 'void' (the inverse of refuseIfVoid — it refuses everything else)
 *   - it touches TWO columns, void_reason and void_reason_corrections, and nothing else
 *   - it cannot change the status, the lines, the number, the dates or the payment grain
 * Every other path (unlock, re-issue, mark/unmark paid, confirm, email, both date edits, import
 * re-commit) still calls refuseIfVoid and still returns 409. Opening this door does not open those.
 *
 * ── APPEND-ONLY ─────────────────────────────────────────────────────────────────────────────────
 * Same pattern as redateEvent/voidEvent in lib/employment-events: the field moves and
 * {at, by, from, to} is APPENDED to a log. The original wording is the first entry's `from`, so it
 * survives every subsequent amendment and is rendered alongside the current text on the detail page
 * and on the PDF. Overwriting without the log would let a bad reason be laundered into a good one.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { writeAudit } from '@/lib/audit';
import { readVoidCorrections, validateVoidReason } from '@/lib/invoice-void';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId, reason } = (req.body || {}) as { invoiceId?: string; reason?: string };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can amend a void reason.' });

  // SAME validation as the original. A thin amendment is no better than a thin reason.
  const checked = validateVoidReason(reason);
  if (!checked.ok) return res.status(400).json({ code: 'bad_reason', message: checked.error });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, status: true, invoice_number: true, job_card_id: true, void_reason: true, void_reason_corrections: true },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  // THE INVERSE GUARD. Only a voided invoice has a void reason to amend; everything else is refused
  // here exactly as refuseIfVoid refuses a void everywhere else.
  if (invoice.status !== 'void') {
    return res.status(409).json({ code: 'not_void', message: 'Only a voided invoice has a void reason to amend.' });
  }
  const from = String(invoice.void_reason ?? '');
  if (from === checked.value) {
    return res.status(409).json({ code: 'unchanged', message: 'That is the wording already recorded.' });
  }

  const log = readVoidCorrections(invoice.void_reason_corrections);
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        // TWO COLUMNS. Nothing else about a voided invoice becomes writable through this path.
        data: {
          void_reason: checked.value,
          void_reason_corrections: [...log, { at: new Date().toISOString(), by: user.id as string, from, to: checked.value }] as any,
        },
      });
      await writeAudit(tx, {
        groupId: user.group_id as string, userId: user.id as string, jobCardId: invoice.job_card_id,
        action: 'invoice.void_reason_amended',
        diff: { number: invoice.invoice_number, from, to: checked.value },
      });
    });
  } catch (e) {
    console.error('Void reason amend error:', e);
    return res.status(500).json({ message: 'Could not amend the void reason.' });
  }
  return res.status(200).json({ message: 'Void reason amended. The original wording is kept.' });
}
