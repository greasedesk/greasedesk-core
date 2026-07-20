/**
 * File: pages/api/import/recommit.ts
 * THE unwind path for an imported invoice that was committed by the broken commit path.
 *
 * POST { stagedInvoiceId, discardCardEdits?: boolean }
 *
 * ATOMIC: it performs the UNLOCK ITSELF, inside the same transaction as the rebuild and the
 * assertion. Run as two calls, a failed re-commit strands the invoice unlocked with zero lines —
 * silently absent from the ledger rather than visibly wrong. One transaction means any failure
 * leaves it exactly as it was.
 *
 * It does NOT mint. `issueInvoiceForCard` draws a number and moves InvoiceSequence.last_value;
 * re-commit deliberately never calls it. The invoice row, its sequence_value and its rendered
 * number are untouched — only its InvoiceLine rows are rebuilt — so a correction can never open a
 * gap in a gapless series.
 *
 * WHAT IT REBUILDS FROM. Staging, not the card. The card is what the broken path (and any later
 * hand-editing) produced; the staged invoice is the parse of the source document, and it survived
 * intact — 100002297's £1,537.37 credit is still there, which is why rebuilding from staging
 * recovers it without anyone re-typing a figure.
 *
 * WHAT GUARANTEES IT. assertImportedInvoiceMatchesSource, called explicitly after the re-freeze:
 * the written rows are re-read FROM STORAGE and must equal the document's printed subtotal, VAT and
 * gross. A mismatch throws and the whole transaction rolls back — nothing is written on a failed
 * correction. The assertion is scoped to the MACHINE write paths (this one and the mint); it is
 * deliberately NOT on mark-paid, where an admin's edit is the source of truth.
 *
 * PAYMENT IS RE-APPLIED FROM THE CAPTURE FILE, never inferred. invoice-unlock clears paid_at,
 * date_paid, receipt_sent_at, payment_method_id and payment_method_snapshot in one update with
 * nothing archiving them first, so the grain was captured to a file BEFORE any unlock. If this
 * invoice is not in that file, re-commit refuses: re-paying from a guess is how a correction
 * quietly becomes a second falsification.
 *
 * OPERATOR TOOL, NOT A PRODUCT FEATURE. It reads the capture file from the filesystem
 * (PAYMENT_GRAIN_FILE, defaulting to the 2026-07-20 capture), so it runs where that file lives —
 * the machine doing the unwind — and refuses everywhere else rather than half-working.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma } from '@prisma/client';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { prisma } from '@/lib/db';
import { requireImportApi, importableSiteIds, requireCanWrite } from '@/lib/admin-guard';
import { getTaxProfile } from '@/lib/tenant-vat';
import { snapshotInvoiceLines } from '@/lib/invoice-issue';
import { assertImportedInvoiceMatchesSource, importAssertError } from '@/lib/import-assert';
import { emitCardItemsFromStaged } from '@/lib/import-emit';
import { writeImportAudit } from '@/lib/audit';
import { tServer } from '@/lib/server-i18n';

const GRAIN_FILE = process.env.PAYMENT_GRAIN_FILE
  ?? join(homedir(), 'Developer/import/payment-grain-capture-2026-07-20.json');

type Grain = {
  external_ref: string; greasedesk_number: string | null; status: string;
  date_paid: string | null; paid_at: string | null;
  payment_method_id: string | null; payment_method_snapshot: string | null;
  receipt_sent_at: string | null; grain_status: string;
};

/** The captured grain for one external ref, or null when the file has no record of it. */
function readGrain(externalRef: string): { ok: true; grain: Grain } | { ok: false; reason: string } {
  if (!existsSync(GRAIN_FILE)) return { ok: false, reason: `the payment-grain capture file is not present at ${GRAIN_FILE}` };
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(GRAIN_FILE, 'utf8')); }
  catch (e: any) { return { ok: false, reason: `the payment-grain capture file could not be read (${e?.message ?? 'unreadable'})` }; }
  const grain = (parsed?.invoices ?? []).find((r: Grain) => r.external_ref === externalRef);
  if (!grain) return { ok: false, reason: `no captured payment grain for ${externalRef} — re-commit will not re-pay from an inference` };
  return { ok: true, grain };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireImportApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'You do not have permission to import invoices.' });
  if (!(await requireCanWrite(vis.groupId, res))) return;

  const { stagedInvoiceId, discardCardEdits } = (req.body || {}) as { stagedInvoiceId?: string; discardCardEdits?: boolean };
  if (!stagedInvoiceId) return res.status(400).json({ message: 'stagedInvoiceId is required.' });

  const staged = await prisma.stagedInvoice.findFirst({
    where: { id: stagedInvoiceId, group_id: vis.groupId },
    include: { lines: { orderBy: { position: 'asc' } }, batch: { select: { id: true, site_id: true } } },
  });
  if (!staged) return res.status(404).json({ message: 'Staged invoice not found.' });
  if (!importableSiteIds(vis).includes(staged.batch.site_id)) {
    return res.status(403).json({ message: 'That batch belongs to a location you do not work in.' });
  }

  // ── REFUSALS, each naming the thing that is not true ────────────────────────────────────────
  if (staged.status !== 'committed' || !staged.invoice_id || !staged.job_card_id) {
    return res.status(409).json({ message: 'That invoice has not been committed — use the wizard to commit it, not re-commit.' });
  }
  if (staged.total_printed == null) {
    return res.status(409).json({
      message: 'That staged invoice has no printed TOTAL captured, so only two of the three figures could be checked. Backfill total_printed before re-committing.',
    });
  }

  const invoice = (await prisma.invoice.findFirst({
    where: { id: staged.invoice_id, group_id: vis.groupId },
    select: {
      id: true, job_card_id: true, invoice_number: true, sequence_value: true, series: true,
      status: true, is_imported: true, external_ref: true, vat_registered_at_issue: true,
      issued_at: true, site: { select: { locale: true } }, lines: { select: { id: true }, take: 1 },
    },
  })) as any;
  if (!invoice) return res.status(404).json({ message: 'The invoice this staged row points at no longer exists.' });
  if (!invoice.is_imported || !invoice.external_ref) {
    return res.status(409).json({ message: 'That invoice is not an imported one — there is no source document to check it against.' });
  }
  // A FROZEN invoice is the EXPECTED input: the unlock happens INSIDE our transaction (below), so
  // there is no window in which the invoice is unlocked-and-absent from the ledger. An
  // already-unlocked one (100002298) is accepted too — it is the same path with nothing to delete.
  const wasFrozen = invoice.lines.length > 0;

  // The captured grain must EXIST. Re-applying payment from an inference is not a correction.
  const grainRead = readGrain(invoice.external_ref);
  if (!grainRead.ok) return res.status(409).json({ message: `Re-commit refused: ${grainRead.reason}.` });
  const grain = grainRead.grain;

  // A card edited SINCE the import holds work this rebuild would discard. That may well be right —
  // but the operator says so per invoice; it is never the default.
  const card = await prisma.jobCard.findUnique({
    where: { id: staged.job_card_id },
    select: { id: true, site_id: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  // "EDITED SINCE THE IMPORT" = its LINES were rewritten after the mint. JobCard has no updated_at,
  // and item timestamps are the better signal anyway: they detect the estimate path's
  // delete-and-recreate, which is precisely what a rebuild from staging would discard. This is the
  // same evidence that exposed 100002297 (items at 14:19:17 against a 14:16:44 mint).
  const newestItem = await prisma.jobCardItem.findFirst({
    where: { job_card_id: card.id },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  const cardEditedSinceImport = !!newestItem && newestItem.created_at > invoice.issued_at;
  if (cardEditedSinceImport && discardCardEdits !== true) {
    const items = await prisma.jobCardItem.findMany({
      where: { job_card_id: card.id },
      select: { description: true, qty: true, unit_price: true },
    });
    const cardTotal = items.reduce((a: number, i: any) => a + Math.round(Number(i.qty) * Number(i.unit_price) * 100), 0);
    return res.status(409).json({
      code: 'CARD_EDITED_SINCE_IMPORT',
      message:
        `This card has been edited since it was imported (${items.length} line(s), £${(cardTotal / 100).toFixed(2)}) ` +
        `and re-commit rebuilds from the staged document (£${Number(staged.subtotal_printed).toFixed(2)}). ` +
        'Those edits will be discarded. Send discardCardEdits: true to confirm.',
      card: { lines: items.length, subtotal: (cardTotal / 100).toFixed(2) },
      staged: { subtotal: Number(staged.subtotal_printed).toFixed(2) },
    });
  }

  const profile = await getTaxProfile(vis.groupId);
  const splitParents = new Set<string>(staged.lines.filter((l: any) => l.parent_line_id).map((l: any) => l.parent_line_id as string));

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      /**
       * 0) THE UNLOCK, INSIDE THIS TRANSACTION — the whole reason this is one call and not two.
       *
       * Run as separate steps, a failed re-commit left the invoice unlocked with zero lines,
       * silently absent from the ledger until someone retried (it happened on the first attempt at
       * 100002295, on a column that did not exist). Folded in here, ANY failure — the assertion, a
       * bad column, a crash — rolls the delete back with everything else, and the invoice stays
       * frozen-and-wrong rather than becoming unlocked-and-absent. Wrong is visible; absent is not.
       */
      const previous = await tx.invoiceLine.findMany({
        where: { invoice_id: invoice.id },
        select: { description: true, qty: true, unit_price: true, line_total: true, line_vat: true },
        orderBy: { position: 'asc' },
      });
      if (wasFrozen) {
        await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } });
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: 'issued', paid_at: null, date_paid: null, receipt_sent_at: null, payment_method_id: null, payment_method_snapshot: null },
        });
        await tx.jobCard.update({ where: { id: card.id }, data: { status: 'invoiced' } });
      }

      // 1) Rebuild the CARD from staging, through the one shared emitter.
      await tx.jobCardItem.deleteMany({ where: { job_card_id: card.id } });
      const emitted = await emitCardItemsFromStaged(tx, {
        groupId: vis.groupId as string,
        cardId: card.id,
        lines: staged.lines,
        splitParentIds: splitParents,
        profile: { defaultRateBp: profile.defaultRateBp, isRegistered: profile.isRegistered },
      });

      // 2) Re-freeze.
      await snapshotInvoiceLines(tx, invoice, {
        goodwill: tServer(invoice.site?.locale, 'invoice', 'warrantyGoodwill'),
        noCharge: tServer(invoice.site?.locale, 'invoice', 'warrantyLine'),
      });

      /**
       * 2b) THE ASSERTION, CALLED EXPLICITLY HERE.
       *
       * It used to live inside snapshotInvoiceLines, which meant it also fired on mark-paid — and
       * there it was wrong: once an invoice is in the ledger an admin's edit is the source of truth,
       * so policing a correction against the original parse made a corrected invoice unfreezable.
       * Scoped off that path (2026-07-20), it has to be invoked HERE, because this is a MACHINE
       * write — a rebuild from the staged parse — and this is exactly where a bad parse must still
       * be refused. Same for the mint in commit.ts, which has always called it directly.
       *
       * Reads the written rows back FROM STORAGE, and throws to roll this whole transaction back.
       */
      const check = await assertImportedInvoiceMatchesSource(tx, {
        invoiceId: invoice.id, groupId: vis.groupId as string, externalRef: invoice.external_ref,
      });
      if (!check.ok) throw importAssertError(invoice.external_ref, check);

      // 3) Re-apply the CAPTURED payment — only now, and only from the file.
      const paidData: any = {};
      if (grain.date_paid) {
        paidData.status = 'paid';
        paidData.date_paid = new Date(`${grain.date_paid}T00:00:00.000Z`);
        paidData.paid_at = grain.paid_at ? new Date(grain.paid_at) : new Date();
        if (grain.payment_method_id) paidData.payment_method_id = grain.payment_method_id;
        if (grain.payment_method_snapshot) paidData.payment_method_snapshot = grain.payment_method_snapshot;
        if (grain.receipt_sent_at) paidData.receipt_sent_at = new Date(grain.receipt_sent_at);
      }
      if (Object.keys(paidData).length) {
        await tx.invoice.update({ where: { id: invoice.id }, data: paidData });
        await tx.jobCard.update({ where: { id: card.id }, data: { status: 'paid' } });
      }

      const after = await tx.invoiceLine.findMany({ where: { invoice_id: invoice.id }, select: { line_total: true, line_vat: true } });
      const sub = after.reduce((a, l) => a + Math.round(Number(l.line_total) * 100), 0);
      const vat = after.reduce((a, l) => a + Math.round(Number(l.line_vat) * 100), 0);

      await writeImportAudit(tx, {
        groupId: vis.groupId as string, actorUserId: vis.userId, batchId: staged.batch.id,
        action: 'import.recommitted',
        diff: {
          external_ref: invoice.external_ref,
          invoice_number: invoice.invoice_number,
          sequence_value: invoice.sequence_value, // unchanged — no number was drawn
          cardEditedSinceImport, discardCardEdits: discardCardEdits === true,
          unlockedInThisTransaction: wasFrozen, // no unlocked-and-absent window
          previous: previous.map((l: any) => ({
            description: l.description, qty: Number(l.qty), unit_price: Number(l.unit_price),
            line_total: Number(l.line_total), line_vat: Number(l.line_vat),
          })),
          lines: { emitted, frozen: after.length },
          written: { subtotal: (sub / 100).toFixed(2), vat: (vat / 100).toFixed(2), total: ((sub + vat) / 100).toFixed(2) },
          printed: {
            subtotal: Number(staged.subtotal_printed).toFixed(2),
            vat: staged.vat_printed == null ? null : Number(staged.vat_printed).toFixed(2),
            total: Number(staged.total_printed).toFixed(2),
          },
          paymentRestored: grain.date_paid
            ? { date_paid: grain.date_paid, method: grain.payment_method_snapshot ?? null, source: 'capture file' }
            : { note: 'no payment grain captured for this invoice', grain_status: grain.grain_status },
        },
      });

      return { emitted, frozen: after.length, sub, vat };
    });

    return res.status(200).json({
      message:
        `Re-committed ${invoice.external_ref} (${invoice.invoice_number}) — ${result.frozen} line(s), ` +
        `£${(result.sub / 100).toFixed(2)} + £${(result.vat / 100).toFixed(2)} VAT, matching the source document.`,
      invoiceNumber: invoice.invoice_number,
      sequenceValue: invoice.sequence_value,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // The assertion refused: nothing was written and the invoice is still unlocked.
    if (msg.startsWith('IMPORT_ASSERT:')) return res.status(409).json({ message: msg.slice('IMPORT_ASSERT:'.length) });
    console.error('[import recommit]', msg);
    return res.status(500).json({ message: 'Re-commit failed; nothing was written.' });
  }
}
