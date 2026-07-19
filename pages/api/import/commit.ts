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
import { requireAdminApi } from '@/lib/admin-guard';
import { placeJobCard } from '@/lib/diary-booking';
import { issueInvoiceForCard } from '@/lib/invoice-issue';
import { writeAudit } from '@/lib/audit';
import { SKIP_COLUMN } from '@/lib/jobcard-status';
import { upsertMemory } from '@/lib/import-memory';
import { getTaxProfile } from '@/lib/tenant-vat';
import { unbalancedSplits } from '@/lib/import-split';

const ATTESTATION = 'imported: the invoice is the record; no photographic evidence exists';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const vis = await requireAdminApi(req, res);
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'Admin access required.' });

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
  // A split must still balance at commit: a template applied retroactively to a parent with a
  // different quantity could otherwise drift after it was saved.
  const broken = unbalancedSplits(staged.lines as any);
  if (broken.length) {
    return res.status(409).json({ message: `Refused: ${broken[0].message} (${broken[0].description})` });
  }

  // Split PARENTS are costed through their children and must not be asked for a cost themselves.
  const splitParents = new Set(staged.lines.filter((l: any) => l.parent_line_id).map((l: any) => l.parent_line_id));
  const undecided = staged.lines.filter((l: any) =>
    !l.is_adjustment && l.parts_cost == null && l.cost_basis == null && !splitParents.has(l.id));
  if (undecided.length) {
    return res.status(400).json({ message: `${undecided.length} line(s) still need a cost decision.` });
  }

  const profile = await getTaxProfile(vis.groupId);
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
      const emit = staged.lines.filter((l: any) => !splitParents.has(l.id));
      for (const l of emit) {
        let catalogueItemId = l.catalogue_item_id;
        if (!l.is_adjustment && l.parts_cost != null) {
          const timesSeen = await tx.stagedLine.count({
            where: { description: l.description, unit_price: l.unit_price, staged_invoice: { group_id: vis.groupId as string } },
          });
          catalogueItemId = await upsertMemory(tx, {
            groupId: vis.groupId as string,
            description: l.description,
            unitPrice: Number(l.unit_price),
            itemType: (l.kind ?? 'part') as any,
            unitCostPennies: Math.round(Number(l.parts_cost) * 100),
            labourHours: l.labour_hours == null ? null : Number(l.labour_hours),
            timesSeen,
            vatRate: /no vat/i.test(l.vat_text ?? '') ? 0 : profile.defaultRateBp / 100,
          });
        }
        await tx.jobCardItem.create({
          data: {
            job_card_id: card.id,
            description: l.description,
            qty: l.qty as any,
            unit_price: l.unit_price as any,
            unit_cost: (l.is_adjustment ? 0 : l.parts_cost) as any, // null stays NULL = unknown
            labour_hours: (l.labour_hours ?? null) as any,
            item_type: (l.kind ?? 'part') as any,
            vat_rate: (/no vat/i.test(l.vat_text ?? '') ? 0 : profile.defaultRateBp / 100) as any,
            catalogue_item_id: catalogueItemId,
            cost_basis: l.cost_basis,
          } as any,
        });
      }

      // 4) PLACEMENT — the one booking guard. Back-dating is already legal; no guard was widened.
      await placeJobCard(tx, {
        jobCardId: card.id,
        resourceId: staged.planned_resource_id as string,
        start: staged.planned_start_at as Date,
        workingMinutes: 60,
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

      return { cardId: card.id, invoiceId };
    });

    return res.status(200).json({ message: 'Committed.', ...out });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith('CLASH:')) return res.status(409).json({ message: `That lift is already taken at that time (${msg.slice(6)}).` });
    if (msg === 'EMPTY_FOOTPRINT') return res.status(409).json({ message: 'That date/time falls outside the site\'s working hours — pick a working day.' });
    console.error('[import commit]', msg);
    return res.status(500).json({ message: 'Commit failed; nothing was written.' });
  }
}
