/**
 * File: pages/api/invoice-addressee.ts
 * ADMIN-ONLY. POST { invoiceId, customerName, customerAddress, accountName, accountAddress, reason }
 * — correct WHO an issued invoice is addressed to, while it is under correction.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The addressee is a snapshot frozen at mint and, until now, the mint was its only writer. A garage
 * whose customer asked for the bill to go to their employer unlocked the invoice, typed the company
 * in, re-issued — and got the original document back, because nothing on the unlock or re-issue
 * path touches those columns and nothing was ever meant to. The button reported success every time.
 *
 * ── A GUARDED EXCEPTION, NOT AN UNLOCK ──────────────────────────────────────────────────────────
 * Deliberately the same narrow shape as invoice-void-amend, which is the only other write path that
 * opens a door in the freeze:
 *   - ADMIN only (a site manager is refused; there is no quieter version of this power)
 *   - it REQUIRES the invoice to be under correction — the inverse of "already frozen"
 *   - it touches FIVE columns: the four addressee snapshots and their append-only log
 *   - it cannot change the status, the number, the lines, the dates or the payment grain
 * Opening this door opens no others: unlock, re-issue, mark/unmark paid, void, the date edits and
 * the import re-commit are all unchanged, and the re-issue path still writes only the rebuild set
 * (enforced by invoice-snapshot-gate, which selects `policy !== 'rebuild'` precisely so that adding
 * this policy could not make that check pass by covering less).
 *
 * ── NOT FOLDED INTO RE-ISSUE, ON PURPOSE ────────────────────────────────────────────────────────
 * Re-issue refuses on estimate divergence, so a garage fixing an addressee would be blocked by an
 * unrelated money problem; its dialog is about what was paid and what is now outstanding; and its
 * amendment log fires only when the TOTAL moves, so a correction folded into it would leave no
 * record at all. Separate action, own reason, own log. See lib/invoice-addressee.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { writeAudit } from '@/lib/audit';
import {
  ADDRESSEE_SELECT, addresseeOf, normaliseAddressee, sameAddressee, printedAddressee,
  validateAddresseeReason, refuseCorrection, appendCorrection,
} from '@/lib/invoice-addressee';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId, customerName, customerAddress, accountName, accountAddress, reason } =
    (req.body || {}) as Record<string, string | undefined>;
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can change who an invoice is addressed to.' });

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id as string },
    select: {
      id: true, status: true, invoice_number: true, job_card_id: true,
      ...ADDRESSEE_SELECT,
      addressee_corrections: true,
      lines: { select: { id: true } },
      // WHAT ELSE IS ALREADY IN THE CUSTOMER'S HANDS. A credit note carries a copy of this same
      // addressee and cannot be changed, so its existence is a refusal, not a warning.
      credit_notes: { select: { credit_note_number: true }, orderBy: { sequence_value: 'asc' }, take: 1 },
      _count: { select: { credit_notes: true } },
    },
  });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  // ── THE REFUSALS, THROUGH THE SHARED PREDICATE ────────────────────────────────────────────────
  // Open-coding these here is one copy away from a second caller disagreeing with them.
  const refusal = refuseCorrection({
    status: invoice.status,
    hasFrozenLines: invoice.lines.length > 0,
    creditNoteCount: invoice._count.credit_notes,
    creditNoteNumber: invoice.credit_notes[0]?.credit_note_number ?? null,
  });
  if (refusal) return res.status(409).json(refusal);

  const checkedReason = validateAddresseeReason(reason);
  if (!checkedReason.ok) return res.status(400).json({ message: checkedReason.message });

  const next = normaliseAddressee({ customerName, customerAddress, accountName, accountAddress });
  if (!next) return res.status(400).json({ message: 'An invoice has to be addressed to somebody — the customer name cannot be empty.' });

  const previous = addresseeOf(invoice);
  // A NO-OP MUST NOT ENTER THE LOG. An entry saying a document was corrected from X to X is a
  // notice about nothing, and it would sit on the customer's copy claiming otherwise.
  if (sameAddressee(previous, next)) {
    return res.status(409).json({
      code: 'nothing_changed',
      message: 'That is what this invoice already says. Nothing has been recorded.',
    });
  }

  const entry = {
    at: new Date().toISOString(),
    by: user.id as string,
    reason: checkedReason.reason,
    from: previous,
    to: next,
  };

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          customer_name_snapshot: next.customerName,
          customer_address_snapshot: next.customerAddress,
          account_name_snapshot: next.accountName,
          account_address_snapshot: next.accountAddress,
          // APPEND, NEVER REPLACE. The original is the first entry's `from` and has to survive
          // every later correction, or a document can be re-addressed twice and lose who it
          // started out naming — the same rule void_reason_corrections follows.
          addressee_corrections: appendCorrection(invoice.addressee_corrections, entry),
        },
      });
      await writeAudit(tx, {
        groupId: user.group_id as string,
        userId: user.id as string,
        jobCardId: invoice.job_card_id,
        action: 'invoice.addressee_corrected',
        diff: {
          number: invoice.invoice_number,
          reason: checkedReason.reason,
          // The PRINTED forms, built by the same rule the document uses, so the audit reads as the
          // page did rather than as four columns somebody has to reassemble.
          from: printedAddressee(previous),
          to: printedAddressee(next),
        },
      });
    });
  } catch (e) {
    console.error('Invoice addressee correction error:', e);
    return res.status(500).json({ message: 'Could not change who this invoice is addressed to.' });
  }

  return res.status(200).json({
    message: 'Addressee corrected — re-issue the invoice to freeze it again.',
    addressee: printedAddressee(next),
  });
}
