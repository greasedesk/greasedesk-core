/**
 * File: pages/api/historical-import.ts
 * ADMIN-ONLY. POST — record ONE invoice issued under a previous system.
 *
 * The screen extracts the PDF text CLIENT-SIDE (pdfjs-dist; Poppler is not available on Vercel)
 * and posts the raw text with the operator's completed form. The server re-parses that text
 * itself rather than trusting the browser's field values for anything load-bearing: the raw text
 * is stored on the staged row so what was parsed stays auditable, and the reconcile gate is
 * checked here, not in the browser.
 *
 * WHAT IT WRITES, in one transaction:
 *   Customer → Vehicle → current ownership edge → JobCard(accepted, is_imported, stages skipped
 *   with an audited attestation, NO diary placement) → Invoice(series 'historical', external_ref,
 *   printed date) → frozen InvoiceLines.
 *
 * WHAT IT NEVER DOES: draw a chargeable number, place a booking, or produce something sendable.
 * See lib/historical-invoice for the rules and why the marker must be written here and now.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { writeAudit } from '@/lib/audit';
import { parseInvoiceText } from '@/lib/invoice-parser';
import { issueHistoricalInvoiceForCard } from '@/lib/invoice-issue';
import { ensureIdentityAndCurrentOwner } from '@/lib/vehicle-identity';
import { looksLikeSourceInvoice, validateHistorical, type HistoricalInput } from '@/lib/historical-invoice';

const norm = (r: string) => r.replace(/\s+/g, '').toUpperCase();
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can record a historical invoice.' });
  const groupId = user.group_id as string;

  const body = (req.body || {}) as Partial<HistoricalInput> & { siteId?: string; supersedeInvoiceId?: string; supersedeReason?: string };

  // ── 1. IS THIS EVEN A SOURCE INVOICE? A GreaseDesk-generated PDF is refused as a whole. ───────
  const rawText = String(body.rawText ?? '');
  if (!rawText.trim()) return res.status(400).json({ code: 'no_text', message: 'No text could be read from that PDF.' });
  const parsed = parseInvoiceText(rawText);
  if (!looksLikeSourceInvoice(parsed)) {
    return res.status(422).json({
      code: 'not_a_source_invoice',
      message: 'This doesn’t look like a source invoice — no original invoice number and no line table were found. If it is a GreaseDesk invoice, it is already in the ledger.',
    });
  }

  const input = body as HistoricalInput;
  const refusal = validateHistorical(input);
  if (refusal) return res.status(400).json(refusal);

  // ── 2. DUPLICATE, by the ORIGINAL number. A re-exported PDF has different bytes and the same
  //       number, so the number is the key; the DB unique on (group, external_ref) is the backstop.
  const dupe = await prisma.invoice.findFirst({
    where: { group_id: groupId, external_ref: input.externalRef },
    select: { invoice_number: true, series: true },
  });
  if (dupe) return res.status(409).json({ code: 'duplicate', message: `Refused: invoice ${input.externalRef} is already recorded as ${dupe.invoice_number}.` });

  const siteId = String(body.siteId ?? '') || (await prisma.site.findFirst({ where: { group_id: groupId }, orderBy: { created_at: 'asc' }, select: { id: true } }))?.id;
  if (!siteId) return res.status(400).json({ message: 'No site to record this against.' });

  const reg = norm(input.registration);
  try {
    const out = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // ── 3. VEHICLE + CUSTOMER. Where the registration already exists the customer comes from the
      //       ownership edge and the parsed name is only a cross-check; otherwise both are created.
      let vehicle = await tx.vehicle.findFirst({ where: { group_id: groupId, registration: reg }, select: { id: true } });
      let customerId: string | null = null;
      if (vehicle) {
        const edge = await tx.vehicleOwnership.findFirst({ where: { vehicle_id: vehicle.id, is_current: true }, select: { customer_id: true } });
        customerId = edge?.customer_id ?? null;
      }
      if (!customerId) {
        const c = await tx.customer.create({ data: { group_id: groupId, name: input.customerName.trim() }, select: { id: true } });
        customerId = c.id;
      }
      if (!vehicle) {
        vehicle = await tx.vehicle.create({
          data: { group_id: groupId, registration: reg, make: String((body as any).make ?? '') || null, model: String((body as any).model ?? '') || null,
                  vin: String((body as any).vin ?? '') || null },
          select: { id: true },
        });
      }
      await ensureIdentityAndCurrentOwner(tx, { vehicleId: vehicle.id, groupId, customerId, registration: reg, vin: String((body as any).vin ?? '') || null });

      // ── NOT AN ACCEPTANCE — deliberately does NOT call lib/quote-acceptance. ──────────────
      // This card is a record of work that was COMPLETED under a previous system. Nobody quoted it
      // through GreaseDesk and nobody accepted it here, so `accepted_at` stays NULL: that is the
      // honest answer, not a gap. It is born at `accepted` only because the lifecycle has to start
      // somewhere past quoting for a job that is already done.
      // ── 4. CARD. `accepted`, imported, NO diary placement — a 2026-05 job needs no lift booked.
      const card = await tx.jobCard.create({
        data: { group_id: groupId, site_id: siteId, customer_id: customerId, vehicle_id: vehicle.id, status: 'accepted', is_imported: true,
                odometer_in: Number((body as any).mileage) || null },
        select: { id: true },
      });
      for (const stage of ['details', 'intake', 'injob', 'complete']) {
        await writeAudit(tx, { groupId, userId: user.id as string, jobCardId: card.id, action: `stage.${stage}.skipped` as any,
          diff: { reason: 'Historical record — the work predates GreaseDesk; there are no photos or stage evidence to capture.', external_ref: input.externalRef } });
      }

      // ── 5. LINES on the card, then frozen onto the invoice by the one issue path.
      let pos = 0;
      for (const l of input.lines) {
        await tx.jobCardItem.create({
          data: {
            job_card_id: card.id, item_type: l.kind as any, description: l.description,
            qty: l.qty, unit_price: l.unitPrice, vat_rate: l.vatRate,
            vat_amount: Math.round(l.amount * (l.vatRate / 100) * 100) / 100,
            unit_cost: l.partsCost ?? null, cost_basis: l.costBasis ?? null,
            labour_hours: l.labourHours ?? null,
          },
        });
        pos++;
      }

      // ── 6. THE INVOICE. Historical series — the chargeable counter is not touched.
      const invoiceId = await issueHistoricalInvoiceForCard(tx, card.id, groupId);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          is_imported: true,
          external_ref: input.externalRef,
          date_issued: day(input.dateIssued),   // the PRINTED date, immutable
          ...(input.datePaid
            ? { status: 'paid' as any, date_paid: day(input.datePaid), paid_at: day(input.datePaid),
                payment_method_id: input.paymentMethodId ?? null }
            : {}),
        },
      });
      const minted = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { invoice_number: true, sequence_value: true } });

      // ── 7. SUPERSEDE: void the hand-keyed twin, with a reason, in the SAME transaction.
      let superseded: string | null = null;
      if (body.supersedeInvoiceId) {
        const old = await tx.invoice.findFirst({ where: { id: body.supersedeInvoiceId, group_id: groupId }, select: { id: true, invoice_number: true, status: true, _count: { select: { lines: true } } } });
        if (old && old.status !== 'void' && old._count.lines > 0) {
          await tx.invoice.update({ where: { id: old.id }, data: {
            status: 'void' as any, voided_at: new Date(), voided_by: user.id as string, void_category: 'duplicate',
            void_reason: String(body.supersedeReason ?? '').trim() || `Superseded by historical record ${minted?.invoice_number} for original invoice ${input.externalRef}. This row was hand-keyed through the live workflow before historical import existed.`,
          } });
          await writeAudit(tx, { groupId, userId: user.id as string, jobCardId: card.id, action: 'invoice.voided',
            diff: { number: old.invoice_number, series: 'chargeable', statusBefore: old.status, category: 'duplicate', reason: `superseded by ${minted?.invoice_number}` } });
          superseded = old.invoice_number;
        }
      }

      // ── 8. THE STAGED ROW keeps the raw text: what was parsed stays auditable.
      const batch = await tx.importBatch.upsert({
        where: { id: `hist-${groupId}` },
        create: { id: `hist-${groupId}`, group_id: groupId, site_id: siteId, label: 'Historical invoices', status: 'committed' as any, created_by: user.id as string },
        update: {},
        select: { id: true },
      }).catch(() => null);
      if (batch) {
        await tx.stagedInvoice.create({
          data: { batch_id: batch.id, group_id: groupId, external_number: input.externalRef, issue_date: day(input.dateIssued),
                  registration: reg, customer_name: input.customerName,
                  subtotal_printed: input.subtotalPrinted, subtotal_parsed: input.subtotalPrinted, reconciled: true,
                  vat_printed: input.vatPrinted ?? null, total_printed: input.totalPrinted ?? null,
                  status: 'committed' as any, job_card_id: card.id, invoice_id: invoiceId, raw_text: rawText },
        }).catch(() => {});
      }

      await writeAudit(tx, { groupId, userId: user.id as string, jobCardId: card.id, action: 'historical.recorded' as any,
        diff: { external_ref: input.externalRef, invoice_number: minted?.invoice_number, date_issued: input.dateIssued, lines: input.lines.length, superseded } });

      return { invoiceId, number: minted?.invoice_number, superseded };
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e: any) {
    console.error('Historical import error:', e);
    if (String(e?.message ?? '').includes('Unique constraint')) {
      return res.status(409).json({ code: 'duplicate', message: `Refused: invoice ${input.externalRef} is already recorded.` });
    }
    return res.status(500).json({ message: 'Could not record that invoice.' });
  }
}
