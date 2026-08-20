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
import { refuseIfVoid, amendmentRequirement } from '@/lib/invoice-void';
import { isUnderCorrection } from '@/lib/invoice';
import { snapshotInvoiceLines, reissueDivergence, billingDivergence, computeNarrativeBlocks } from '@/lib/invoice-issue';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  // `confirm` is the caller saying the human has read the consequence and said yes. It is NOT a
  // permission flag: the server still decides WHAT needed confirming and refuses if it did not
  // arrive, so a client that forgets to ask cannot amend a paid invoice by omission.
  const { invoiceId, action, confirm } = (req.body || {}) as { invoiceId?: string; action?: 'unlock' | 'reissue'; confirm?: boolean };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });
  const act = action === 'reissue' ? 'reissue' : 'unlock';

  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can unlock or re-issue an invoice.' });

  const invoice = (await prisma.invoice.findFirst({
    where: { id: invoiceId, group_id: user.group_id },
    select: { id: true, group_id: true, status: true, series: true, invoice_number: true, job_card_id: true, receipt_sent_at: true, vat_registered_at_issue: true, amount_paid_pennies: true, paid_at: true, date_paid: true, payment_method_snapshot: true, amendments: true, job_card: { select: { status: true } }, lines: { select: { id: true, line_total: true, line_vat: true } }, site: { select: { locale: true } } },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

  // THE SHARP EDGE. `reissue` gates on the ABSENCE of lines, and this guard sits ABOVE that gate on
  // purpose: a void keeps its lines, so it would fail the no-lines check for the right reason
  // today — but the moment anyone unlocks-then-voids, or the precondition changes, re-issue would
  // read a void as "unlocked, ready to re-freeze" and silently revive a retired document.
  // Guarding on the status, above both branches, is the version of this that cannot rot.
  const voided = refuseIfVoid(invoice);
  if (voided) return res.status(409).json(voided);

  // The `invoice.sent` signal is needed by BOTH branches — the re-issue confirmation below, and
  // the unlock audit — so it is read once, here.
  const sentAudit = await prisma.auditLog.findFirst({
    where: { entity_id: invoice.job_card_id, action: 'invoice.sent' },
    select: { id: true },
  });

  if (act === 'reissue') {
    // Re-freeze the corrected card lines and re-lock. Only meaningful while unlocked (no lines).
    if (invoice.lines.length > 0) return res.status(409).json({ message: 'This invoice is already frozen — unlock it first to make corrections.' });

    // ── ONE DIALOG, AT THE MOMENT IT CAN TELL THE TRUTH (ruling 2026-08-13) ─────────────────────
    // This used to ask at unlock as well. At unlock nothing has changed yet, so the only honest
    // sentence is "paid £120.00 … the job card comes to £120.00. That settles it exactly." — a
    // warning that names no new figure, because none exists. RE-ISSUE is where the customer's
    // document actually changes and where all three numbers are real: what was paid, what it now
    // comes to, and what that leaves outstanding. Two dialogs taught people to click through both.
    //
    // Unlock is now safe to take without ceremony: it preserves the payment and deletes only the
    // frozen lines, and re-freezing them unchanged puts the invoice back exactly as it was.
    const requirement = amendmentRequirement(invoice, !!sentAudit);
    if (requirement.level !== 'none' && !confirm) {
      const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
      // WHAT THIS WILL BECOME. Three sources, in order of who actually knows:
      //   1. a divergence — the card and the agreed price disagree, so the card's figure is the news;
      //   2. the ACCEPTED version — what a re-issue will snapshot. Essential once unlocked, because
      //      the frozen lines are already deleted and reading them gives £0.00, which is what the
      //      first gate run put in front of the user;
      //   3. the frozen lines — the ordinary pre-unlock case.
      const frozenTotal = invoice.lines.reduce((a: number, l: any) => a + Math.round((Number(l.line_total) + Number(l.line_vat)) * 100), 0);
      const live = await billingDivergence(prisma, invoice.job_card_id, { series: invoice.series });
      const acceptedNow = frozenTotal === 0
        ? await prisma.quoteVersion.findFirst({ where: { job_card_id: invoice.job_card_id, status: 'accepted' }, orderBy: { version: 'desc' }, select: { gross_pennies: true } })
        : null;
      const becoming = live ? live.livePennies : (acceptedNow?.gross_pennies ?? frozenTotal);
      const paidPart = requirement.level === 'confirm_paid'
        ? (requirement.amountPaidPennies == null
          // Paid before the amount was ever recorded: say unknown rather than assume the total.
          ? `This invoice is marked paid, but the amount received was not recorded. `
          : `This invoice was paid: ${gbp(requirement.amountPaidPennies)}${requirement.methodLabel ? ` by ${requirement.methodLabel}` : ''}${requirement.paidAt ? ` on ${requirement.paidAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}. `)
        : `${requirement.number ?? 'This invoice'} has already been sent to the customer. `;
      const balance = requirement.level === 'confirm_paid' && requirement.amountPaidPennies != null
        ? becoming - requirement.amountPaidPennies : null;
      return res.status(409).json({
        code: 'confirm_required',
        level: requirement.level,
        message: `${paidPart}The job card now comes to ${gbp(becoming)}.`
          + (balance == null ? '' : balance > 0 ? ` That would leave ${gbp(balance)} outstanding.` : balance < 0 ? ` That would leave ${gbp(-balance)} to refund.` : ' That settles it exactly.')
          + ` The payment record is kept, and the re-issued invoice will say it was amended so the customer can tell the two copies apart.`,
        becomingPennies: becoming,
        amountPaidPennies: requirement.level === 'confirm_paid' ? requirement.amountPaidPennies : null,
      });
    }

    // What the customer's copy says today. Captured BEFORE the re-snapshot, or the log records the
    // new figure twice and the amendment becomes invisible.
    const beforeRow = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      select: { amendments: true },
    });
    // WHAT THE CUSTOMER'S COPY SAYS. By re-issue time the frozen lines are gone, so this cannot be
    // read from the invoice — it is captured at UNLOCK, before they are deleted, and kept in the
    // append-only audit row. Falling back to 0 (as the first version did) put "from £0.00" in the
    // amendment log, which would have told a customer their invoice went from nothing to £180.
    const unlockRow = await prisma.auditLog.findFirst({
      where: { entity_id: invoice.job_card_id, action: 'invoice.unlocked' },
      orderBy: { created_at: 'desc' }, select: { diff_json: true },
    });
    const beforePennies: number = (() => {
      const fromUnlock = (unlockRow?.diff_json as any)?.totalBefore;
      if (typeof fromUnlock === 'number') return fromUnlock;
      const log = Array.isArray(beforeRow?.amendments) ? (beforeRow!.amendments as any[]) : [];
      if (log.length) return Number(log[log.length - 1]?.toPennies ?? 0);
      return invoice.amount_paid_pennies ?? 0;
    })();

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
        // ── AND THE NARRATIVE BLOCKS, REBUILT FROM WHAT IS TRUE NOW ─────────────────────────
        // These used to be written only by the original mint, so a re-issue corrected the money
        // and left the advisory block saying what it had been wrong about — stale tyre depths,
        // and findings listed as outstanding that had since been closed. The button reported
        // success and part of the document did not move: the same shape as the £75 that survived
        // four unlock/re-issue cycles on 100003203.
        //
        // REBUILT FROM TODAY, deliberately, and the re-issue screen says so before it is pressed.
        // An admin correcting a typo an hour later wants exactly that. One re-issuing in March
        // gets what the car needs in March, which is a real change to what the customer was told
        // — so it is named on the button rather than discovered afterwards.
        const blocks = await computeNarrativeBlocks(tx, invoice.group_id, invoice.job_card_id);
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { due_items_snapshot: blocks.dueItemsBlock, work_done_snapshot: blocks.workDone },
        });
        if (invoice.series === 'warranty') {
          await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'settled' as any } }); // back to terminal
        }
        // ── THE AMENDMENT LOG: APPEND, NEVER REPLACE ────────────────────────────────────────
        // The invoice keeps its NUMBER, so a customer can hold two documents that differ. This is
        // what makes them distinguishable, and it is append-only so a second amendment cannot erase
        // the first — the same shape as void_reason_corrections and EmploymentEvent.correction_json.
        const after = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { lines: { select: { line_total: true, line_vat: true } } } });
        const toPennies = (after?.lines ?? []).reduce((a: number, l: any) => a + Math.round((Number(l.line_total) + Number(l.line_vat)) * 100), 0);
        const priorLog = Array.isArray(invoice.amendments) ? invoice.amendments : [];
        const entry = {
          at: new Date().toISOString(),
          by: user.id as string,
          fromPennies: beforePennies,
          toPennies,
          wasSent: !!sentAudit || !!invoice.receipt_sent_at,
          wasPaid: invoice.status === 'paid' || invoice.amount_paid_pennies != null,
        };
        // Only a change of FIGURE is an amendment worth telling the customer about. A re-issue that
        // lands on the same total (a description tidied, a line reordered) leaves the log alone —
        // otherwise the document collects "amended" notices that mean nothing.
        // AND ONLY IF THEY HAVE A COPY. An invoice nobody has seen has no second version to be
        // distinguished from; stamping "amended" on it would be a notice about nothing, and the
        // first gate run produced exactly that on a quiet invoice.
        if (toPennies !== beforePennies && (entry.wasSent || entry.wasPaid)) {
          await tx.invoice.update({ where: { id: invoice.id }, data: { amendments: [...priorLog, entry] as any } });
        }
        await writeAudit(tx, {
          groupId: user.group_id as string, userId: user.id as string, jobCardId: invoice.job_card_id,
          action: 'invoice.reissued',
          diff: {
            number: invoice.invoice_number,
            fromPennies: beforePennies, toPennies,
            wasSent: entry.wasSent, wasPaid: entry.wasPaid,
            amountPaidPennies: invoice.amount_paid_pennies ?? null,
            balancePennies: invoice.amount_paid_pennies == null ? null : toPennies - invoice.amount_paid_pennies,
            amended: toPennies !== beforePennies,
          },
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
  // THE SHARED PREDICATE, not an open-coded copy of it. The customer-facing invoice view asks the
  // same question from the other side (lib/invoice::isUnderCorrection) and must get the same answer.
  if (isUnderCorrection({ status: invoice.status, hasFrozenLines: invoice.lines.length > 0 })) {
    return res.status(409).json({ message: 'This invoice is already unlocked — correct the estimate, then re-issue it.' });
  }

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Drop the frozen snapshot — the absence of lines IS the unlocked/editable state. While
      // unlocked the invoice contributes nothing to the ledger (honest "under correction").
      await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } });
      // ── THE PAYMENT SURVIVES THE CORRECTION ───────────────────────────────────────────────
      // This used to null paid_at, date_paid, the method and receipt_sent_at. There is no Payment
      // table, so those columns ARE the record: unlocking a paid invoice destroyed the only proof
      // that £551.26 arrived by card on 8 August — the exact thing a garage needs in the dispute
      // the correction might cause. It also moved money between months: nulling the paid date
      // removed it from August, and re-marking paid stamped today, so a September correction
      // silently crossed a VAT quarter.
      //
      // The status still steps back to `issued` because the lines are gone and the document is
      // genuinely under correction — but WHAT WAS RECEIVED is untouched, and amount_paid_pennies
      // carries the figure the balance is derived from afterwards.
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'issued' } });
      // Card rejoins the spine at `invoiced` so re-issue / re-pay re-freezes normally.
      await tx.jobCard.update({ where: { id: invoice.job_card_id }, data: { status: 'invoiced' } });
      await writeAudit(tx, {
        groupId: user.group_id as string,
        userId: user.id as string,
        jobCardId: invoice.job_card_id,
        action: 'invoice.unlocked',
        // totalBefore is the figure on the copy the customer holds. Recorded HERE because this is
        // the last moment it exists — the frozen lines are deleted in this same transaction.
        diff: {
          number: invoice.invoice_number, statusBefore: invoice.status, cardStatusBefore: invoice.job_card?.status,
          totalBefore: invoice.lines.reduce((a: number, l: any) => a + Math.round((Number(l.line_total) + Number(l.line_vat)) * 100), 0),
          amountPaidPennies: invoice.amount_paid_pennies ?? null,
        },
      });
    });
  } catch (e) {
    console.error('Invoice unlock error:', e);
    return res.status(500).json({ message: 'Could not unlock the invoice.' });
  }
  return res.status(200).json({ message: 'Invoice unlocked — correct the estimate, then re-issue (or re-pay) to freeze it again.' });
}
