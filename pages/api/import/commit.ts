/**
 * File: pages/api/import/commit.ts
 * ADMIN-only. Commit ONE staged invoice to the ledger, THROUGH THE APP'S OWN WRITE PATHS.
 *
 * This endpoint is a DRIVER, not a second ledger. It owns no invoice logic: numbering, freezing,
 * tax and placement all happen in the same chokepoints the UI uses.
 *   placeJobCard          — the one booking guard (footprint + clash)
 *   SKIP_COLUMN           — the photo-stage soft gate; the attestation IS an audited skip+reason
 *   issueInvoiceForCard   — the one mint (assigns the GreaseDesk number, freezes lines)
 *   writeAudit            — the card's trail
 *
 * HARD GATES, refused before anything is written:
 *   • reconciliation — parsed line amounts must equal the printed Subtotal
 *   • idempotency    — an external_ref already in the ledger cannot be posted twice
 *   • costed lines   — every non-adjustment line needs a cost decision (or an explicit unknown)
 *
 * NUMBERING: the GreaseDesk series is minted NORMALLY and stays gapless. The Xero number is carried
 * in Invoice.external_ref and shown as the primary number on imported invoices, with the GreaseDesk
 * number secondary — so the historic document is recognisable while our own series is untouched.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireImportApi, importableSiteIds, requireCanWrite } from '@/lib/admin-guard';
import { placeJobCard } from '@/lib/diary-booking';
import { issueInvoiceForCard } from '@/lib/invoice-issue';
import { writeAudit, writeImportAudit } from '@/lib/audit';
import { assertImportedInvoiceMatchesSource, importAssertError } from '@/lib/import-assert';
import { emitCardItemsFromStaged } from '@/lib/import-emit';
import { SKIP_COLUMN } from '@/lib/jobcard-status';
import { upsertMemory } from '@/lib/import-memory';
import { getTaxProfile } from '@/lib/tenant-vat';
import { unbalancedSplits } from '@/lib/import-split';
import { blockingReasons } from '@/lib/import-blockers';

const ATTESTATION = 'imported: the invoice is the record; no photographic evidence exists';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const vis = await requireImportApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'You do not have permission to import invoices.' });
  // Committing an import CREATES NEW WORK — a job card and a minted invoice — so it sits behind the
  // same billing gate as /api/jobcard. Without this a lapsed tenant could keep writing to the
  // ledger through the importer while every other creation path refused them.
  if (!(await requireCanWrite(vis.groupId, res))) return; // sends 402 itself

  const { id, attest } = (req.body || {}) as { id?: string; attest?: boolean };
  if (!id) return res.status(400).json({ message: 'id is required.' });
  if (!attest) {
    return res.status(400).json({ message: 'An attestation is required: the invoice is the record and no photographic evidence exists.' });
  }

  const staged = await prisma.stagedInvoice.findFirst({
    where: { id, group_id: vis.groupId },
    include: { lines: { orderBy: { position: 'asc' } }, batch: { select: { id: true, site_id: true } } },
  });
  if (!staged) return res.status(404).json({ message: 'Staged invoice not found.' });

  // ── GATES ────────────────────────────────────────────────────────────────────────────────────
  if (staged.status === 'committed') return res.status(409).json({ message: 'Already committed.' });
  if (!staged.reconciled) {
    return res.status(409).json({
      message: `Refused: parsed lines total ${Number(staged.subtotal_parsed).toFixed(2)} but the invoice prints ${Number(staged.subtotal_printed).toFixed(2)}. An invoice that does not reconcile cannot be committed.`,
    });
  }
  const dupe = await prisma.invoice.findFirst({
    where: { group_id: vis.groupId, external_ref: staged.external_number },
    select: { id: true, invoice_number: true },
  });
  if (dupe) return res.status(409).json({ message: `Refused: ${staged.external_number} is already in the ledger as ${dupe.invoice_number}.` });
  if (!staged.planned_start_at || !staged.planned_resource_id) {
    return res.status(400).json({ message: 'Choose a date and a lift before committing.' });
  }
  // Duration is REQUIRED, not defaulted. Silently placing every imported card as a flat hour is
  // what made occupancy wrong in the first place; refusing is better than guessing.
  if (staged.planned_working_minutes == null || staged.planned_working_minutes <= 0) {
    return res.status(400).json({ message: 'Set the job duration before committing — an imported card must carry the time the work actually took.' });
  }
  // A split must still balance at commit: a template applied retroactively to a parent with a
  // different quantity could otherwise drift after it was saved.
  const broken = unbalancedSplits(staged.lines as any);
  if (broken.length) {
    return res.status(409).json({ message: `Refused: ${broken[0].message} (${broken[0].description})` });
  }

  // Split PARENTS are costed through their children and must not be asked for a cost themselves.
  const splitParents = new Set<string>(staged.lines.filter((l: any) => l.parent_line_id).map((l: any) => l.parent_line_id));

  // ONE definition of "outstanding", shared with both wizard steps, and it names the field:
  // a labour line is satisfied by HOURS (a parts cost on labour is meaningless), a part line by
  // its cost or catalogue item. The refusal lists the reasons rather than a bare count, so it is
  // actionable from where the commit was refused.
  const blockers = blockingReasons(staged.lines as any);
  if (blockers.length) {
    return res.status(400).json({
      message: `${blockers.length} line(s) still need a decision: ` +
        blockers.map((b) => `${b.description} — ${b.reason}`).join('; '),
      blockers,
    });
  }

  const profile = await getTaxProfile(vis.groupId);
  // SITE SCOPE before anything is minted: the batch's location must be one the caller works in.
  if (!importableSiteIds(vis).includes(staged.batch.site_id)) {
    return res.status(403).json({ message: 'That batch belongs to a location you do not work in.' });
  }
  const siteId = staged.batch.site_id;

  try {
    const out = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1) VEHICLE + CUSTOMER — find-or-create by registration; attach, never duplicate.
      const norm = (staged.registration ?? '').toUpperCase().replace(/\s+/g, '');
      let vehicle = norm
        ? await tx.vehicle.findFirst({ where: { group_id: vis.groupId as string, registration_normalized: norm }, select: { id: true } })
        : null;
      let customerId: string | null = null;
      if (vehicle) {
        const edge = await tx.vehicleOwnership.findFirst({
          where: { vehicle_id: vehicle.id, is_current: true, valid_to: null },
          select: { customer_id: true },
        });
        customerId = edge?.customer_id ?? null;
      }
      if (!customerId) {
        const c = await tx.customer.create({
          data: { group_id: vis.groupId as string, site_id: siteId, name: `Imported ${staged.external_number}` },
          select: { id: true },
        });
        customerId = c.id;
      }
      if (!vehicle) {
        vehicle = await tx.vehicle.create({
          data: { group_id: vis.groupId as string, registration: staged.registration ?? staged.external_number, registration_normalized: norm || staged.external_number },
          select: { id: true },
        });
        await tx.vehicleOwnership.create({ data: { vehicle_id: vehicle.id, customer_id: customerId, is_current: true } });
      }

      // 2) CARD — flagged imported so the chaser and dashboards can tell.
      const card = await tx.jobCard.create({
        data: {
          group: { connect: { id: vis.groupId as string } },
          site: { connect: { id: siteId } },
          customer: { connect: { id: customerId } },
          vehicle: { connect: { id: vehicle.id } },
          status: 'accepted',
          is_imported: true,
          import_batch_id: staged.batch.id,
        },
        select: { id: true },
      });

      // 3) LINES — cost goes to the CATALOGUE, the line inherits. The browser never sources cost.
      //    A SPLIT parent is replaced by its children: the children carry the breakdown and, by the
      //    balance invariant, sum to exactly what the parent printed — so the invoice total is
      //    identical either way. An unsplit line commits as itself.
      // ONE EMITTER, shared with the re-commit path (lib/import-emit) — VAT from
      // computeQuoteTotals and printed amounts that survive the 2-dp column. A correction pass with
      // its own copy of this logic would be the original defect wearing a different hat.
      await emitCardItemsFromStaged(tx, {
        groupId: vis.groupId as string,
        cardId: card.id,
        lines: staged.lines,
        splitParentIds: splitParents,
        profile: { defaultRateBp: profile.defaultRateBp, isRegistered: profile.isRegistered },
      });

      // 4) PLACEMENT — the one booking guard. Back-dating is already legal; no guard was widened.
      await placeJobCard(tx, {
        jobCardId: card.id,
        resourceId: staged.planned_resource_id as string,
        start: staged.planned_start_at as Date,
        // The operator's own figure from step 3. Falls back to 60 only when nothing was set,
        // which the wizard prevents — a real duration is required before commit.
        workingMinutes: staged.planned_working_minutes ?? 60,
        siteIds: vis.activeSiteIds,
      });

      // 5) STAGES — the attestation is an AUDITED SKIP, not a bypassed gate. The existing
      //    all_stages_done gate already reads (done || skipped) for the three photo stages.
      await tx.jobCard.update({
        where: { id: card.id },
        data: {
          stage_details_done: true,
          [SKIP_COLUMN.intake]: true,
          [SKIP_COLUMN.injob]: true,
          [SKIP_COLUMN.complete]: true,
        } as any,
      });
      for (const stage of ['intake', 'injob', 'complete'] as const) {
        await writeAudit(tx, {
          groupId: vis.groupId as string, userId: vis.userId, jobCardId: card.id,
          action: `stage.${stage}.skipped`, diff: { reason: ATTESTATION, external_ref: staged.external_number },
        });
      }

      // 6) INVOICE — minted through the ONE issue path; the GreaseDesk series stays gapless.
      const invoiceId = await issueInvoiceForCard(tx, card.id, vis.groupId as string);
      const basis = staged.lines.some((l: any) => l.cost_basis === 'estimated')
        ? (staged.lines.every((l: any) => l.cost_basis === 'estimated' || l.is_adjustment) ? 'estimated' : 'mixed')
        : 'actual';
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          is_imported: true,
          external_ref: staged.external_number,
          cost_basis: basis,
          date_issued: staged.issue_date, // the PRINTED date, immutable
        },
      });

      /**
       * 6b) THE POST-COMMIT ASSERTION — the guarantee we thought we had.
       *
       * Reads the InvoiceLine rows BACK FROM STORAGE and requires them to equal what the source
       * document printed: subtotal, VAT, gross. Any mismatch throws, and because we are inside the
       * mint transaction the invoice, its lines, the card, the placement and the sequence value all
       * roll back — nothing is written and no number is consumed.
       *
       * It reads storage rather than the objects just built ON PURPOSE: the objects are what this
       * code believes it did; the rows are what it actually did. Every defect found on 2026-07-20
       * lived in that gap.
       */
      const check = await assertImportedInvoiceMatchesSource(tx, {
        invoiceId, groupId: vis.groupId as string, externalRef: staged.external_number,
      });
      if (!check.ok) throw importAssertError(staged.external_number, check);

      // 7) PAID — historic invoices arrive settled.
      await tx.jobCard.update({ where: { id: card.id }, data: { status: 'paid' } });
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'paid', date_paid: staged.issue_date } });
      await writeAudit(tx, {
        groupId: vis.groupId as string, userId: vis.userId, jobCardId: card.id,
        action: 'invoice.minted', diff: { imported: true, external_ref: staged.external_number },
      });

      await tx.stagedInvoice.update({
        where: { id: staged.id },
        data: { status: 'committed', job_card_id: card.id, invoice_id: invoiceId },
      });

      const minted = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { invoice_number: true } });
      await writeImportAudit(tx, {
        groupId: vis.groupId as string, actorUserId: vis.userId, batchId: staged.batch.id,
        action: 'import.committed',
        diff: { external_ref: staged.external_number, invoice_number: minted?.invoice_number, job_card_id: card.id },
      });

      // BATCH LIFECYCLE: the batch closes when nothing is outstanding — every invoice committed or
      // deliberately skipped. Without this the status stayed 'open' forever and the states in the
      // enum were unreachable.
      const outstanding = await tx.stagedInvoice.count({
        where: { batch_id: staged.batch.id, status: { in: ['pending', 'in_progress'] } },
      });
      if (outstanding === 0) {
        const [c, sk, tot] = await Promise.all([
          tx.stagedInvoice.count({ where: { batch_id: staged.batch.id, status: 'committed' } }),
          tx.stagedInvoice.count({ where: { batch_id: staged.batch.id, status: 'skipped' } }),
          tx.stagedInvoice.count({ where: { batch_id: staged.batch.id } }),
        ]);
        await tx.importBatch.update({ where: { id: staged.batch.id }, data: { status: 'committed' } });
        await writeImportAudit(tx, {
          groupId: vis.groupId as string, actorUserId: vis.userId, batchId: staged.batch.id,
          action: 'import.batch_closed', diff: { committed: c, skipped: sk, total: tot },
        });
      }

      return { cardId: card.id, invoiceId };
    });

    return res.status(200).json({ message: 'Committed.', ...out });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith('CLASH:')) return res.status(409).json({ message: `That lift is already taken at that time (${msg.slice(6)}).` });
    if (msg === 'EMPTY_FOOTPRINT') return res.status(409).json({ message: 'That date/time falls outside the site\'s working hours — pick a working day.' });
    // The post-commit assertion refused: a REFUSAL, not a crash. The operator needs the arithmetic,
    // not "commit failed" — the message names which figure disagreed and by how much.
    if (msg.startsWith('IMPORT_ASSERT:')) return res.status(409).json({ message: msg.slice('IMPORT_ASSERT:'.length) });
    console.error('[import commit]', msg);
    return res.status(500).json({ message: 'Commit failed; nothing was written.' });
  }
}
