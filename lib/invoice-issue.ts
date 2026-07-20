/**
 * File: lib/invoice-issue.ts
 * ISSUE + FREEZE chokepoints. FREEZE-AT-ISSUE (ruling 2026-07-12, supersedes "live while
 * issued"): the lines snapshot into InvoiceLine AT MINT and the ledger reads only that copy.
 *
 *  issueInvoiceForCard          → mint a CHARGEABLE number + header snapshot + LINE FREEZE.
 *  issueWarrantyInvoiceForCard  → the comeback path: mint from the independent WARRANTY counter,
 *                                 freeze the goodwill shape (retail lines + one zeroing line,
 *                                 sum £0) and land TERMINAL at `settled` — never AR, never paid.
 *  snapshotInvoiceLines         → THE freeze: copy the card's items into InvoiceLine (with the
 *                                 frozen classification: item_type + labour_outsourced).
 *                                 Idempotent (replaces any previous snapshot) — fires at issue,
 *                                 at re-issue after an ADMIN unlock, and at re-pay.
 *
 * All run inside the caller's tx (a minted number rolls back with a failed issue). Sticky:
 * one-per-card (Invoice.job_card_id @unique) — re-entering `invoiced` never re-mints.
 * TODO(tighten): InvoiceLine.item_type is nullable only for pre-backfill legacy rows — all rows
 * were classified 2026-07-12 and every writer here sets it; tighten the column to NOT NULL in a
 * follow-up migration. A nullable classification column on the ledger is a hole waiting for a null.
 */
import { Prisma } from '@prisma/client';
import { assertImportedInvoiceMatchesSource, importAssertError } from '@/lib/import-assert';
import { assignInvoiceNumber, assignWarrantyNumber, formatInvoiceNumber } from '@/lib/invoice-number';
import { resolveCompanyIdentity } from '@/lib/invoice';

const CARD_SELECT = {
  site_id: true,
  odometer_in: true,
  group: { select: { group_name: true, company_number: true, vat_number: true, address: true, vat_registered: true, invoice_prefix: true, invoice_pad_width: true, invoice_fy_digits: true, fy_start_month: true, invoice_warranty_prefix: true } },
  site: { select: { company_number: true, vat_number: true, address: true } },
  customer: { select: { name: true, address: true } },
  vehicle: { select: { registration: true, make: true, model: true, vin: true, mileage_at_create: true } },
} as const;

async function createInvoiceRow(
  tx: Prisma.TransactionClient,
  jobCardId: string,
  groupId: string,
  series: 'chargeable' | 'warranty',
): Promise<string> {
  const card = (await tx.jobCard.findUnique({ where: { id: jobCardId }, select: CARD_SELECT })) as any;
  if (!card) throw new Error('CARD_NOT_FOUND');

  const identity = resolveCompanyIdentity(card.group, card.site);
  const issuedAt = new Date();
  const seq = series === 'warranty' ? await assignWarrantyNumber(tx, groupId) : await assignInvoiceNumber(tx, groupId);
  const number = formatInvoiceNumber(
    {
      prefix: series === 'warranty' ? card.group.invoice_warranty_prefix : card.group.invoice_prefix,
      padWidth: card.group.invoice_pad_width,
      fyDigits: card.group.invoice_fy_digits,
      fyStartMonth: card.group.fy_start_month,
      issuedAt,
    },
    seq,
  );
  const vehicleDesc = [card.vehicle?.make, card.vehicle?.model].filter(Boolean).join(' ') || null;

  const invoice = await tx.invoice.create({
    data: {
      group_id: groupId,
      job_card_id: jobCardId,
      site_id: card.site_id,
      status: 'issued',
      series,
      sequence_value: seq,
      invoice_number: number,
      issued_at: issuedAt,
      date_issued: issuedAt, // the DOCUMENT date starts as the mint date; manager-editable thereafter
      company_name_snapshot: identity.name,
      company_vat_number_snapshot: identity.vatNumber,
      company_address_snapshot: identity.address,
      customer_name_snapshot: card.customer?.name ?? '',
      customer_address_snapshot: card.customer?.address ?? null,
      vehicle_reg_snapshot: card.vehicle?.registration ?? null,
      vehicle_desc_snapshot: vehicleDesc,
      vehicle_vin_snapshot: card.vehicle?.vin ?? null,
      vehicle_mileage_snapshot: card.odometer_in ?? card.vehicle?.mileage_at_create ?? null, // same resolution as the card's "Mileage in"
      vat_registered_at_issue: !!card.group.vat_registered,
    },
    select: { id: true },
  });
  return invoice.id;
}

/** Mint a chargeable invoice AND freeze its lines in the same tx (freeze-at-issue). */
export async function issueInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string): Promise<string> {
  const id = await createInvoiceRow(tx, jobCardId, groupId, 'chargeable');
  const inv = (await tx.invoice.findUnique({ where: { id }, select: { id: true, job_card_id: true, series: true, vat_registered_at_issue: true } })) as any;
  await snapshotInvoiceLines(tx, inv, { goodwill: '', noCharge: '' }); // texts unused on the chargeable branch
  return id;
}

/** Mint a warranty invoice, freeze the goodwill shape, and land TERMINAL at `settled` — all one tx. */
export async function issueWarrantyInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string, warrantyTexts: { goodwill: string; noCharge: string }): Promise<string> {
  const id = await createInvoiceRow(tx, jobCardId, groupId, 'warranty');
  const inv = (await tx.invoice.findUnique({ where: { id }, select: { id: true, job_card_id: true, series: true, vat_registered_at_issue: true } })) as any;
  await snapshotInvoiceLines(tx, inv, warrantyTexts);
  await tx.invoice.update({ where: { id }, data: { status: 'settled' as any } }); // £0, closed — never AR, never paid
  return id;
}

/**
 * THE freeze — copy the card's items into InvoiceLine with the frozen classification
 * (item_type + labour_outsourced). Fires at ISSUE, at RE-ISSUE after an ADMIN unlock, and
 * (idempotently) at re-pay. Chargeable → snapshot with VAT gated by registration AT ISSUE.
 * Warranty (ruling 2026-07-12, supersedes "never itemised") → the real lines at NET retail plus
 * ONE goodwill line zeroing the total (lines sum to £0 — any consumer summing warranty lines
 * still gets zero; NO VAT on any warranty line). Empty card → the legacy single £0 line.
 * `warrantyTexts` are resolved by the caller (site-locale i18n) — this chokepoint doesn't reach
 * into translation files. `freezeVehicleFacts` is TRUE only on the mark-paid path — money
 * freezes at issue, identity facts freeze at paid (the deliberate asymmetry, see invoice-doc).
 */
export async function snapshotInvoiceLines(
  tx: Prisma.TransactionClient,
  invoice: { id: string; job_card_id: string; series: 'chargeable' | 'warranty' | string; vat_registered_at_issue: boolean },
  warrantyTexts: { goodwill: string; noCharge: string },
  opts: { freezeVehicleFacts?: boolean } = {},
): Promise<void> {
  await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } }); // idempotent re-freeze

  // VEHICLE-FACT RE-SNAPSHOT — the DELIBERATE ASYMMETRY (do not "tidy" to match the line freeze):
  // money freezes at ISSUE; identity facts (reg/VIN/mileage) stay LIVE-read while issued and
  // freeze ONLY on the mark-paid path (freezeVehicleFacts: true). Company / customer identity
  // stays issue-snapshotted (different concern).
  if (opts.freezeVehicleFacts) {
    const cardNow = (await tx.jobCard.findUnique({
      where: { id: invoice.job_card_id },
      select: { odometer_in: true, vehicle: { select: { registration: true, vin: true, mileage_at_create: true } } },
    })) as any;
    if (cardNow) {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          vehicle_reg_snapshot: cardNow.vehicle?.registration ?? null,
          vehicle_vin_snapshot: cardNow.vehicle?.vin ?? null,
          vehicle_mileage_snapshot: cardNow.odometer_in ?? cardNow.vehicle?.mileage_at_create ?? null,
        },
      });
    }
  }

  if (invoice.series === 'warranty') {
    const wItems = (await tx.jobCardItem.findMany({
      where: { job_card_id: invoice.job_card_id },
      select: { item_type: true, description: true, qty: true, unit_price: true, unit_cost: true, catalogue_item_id: true, labour_hours: true, labour_outsourced: true },
      orderBy: { created_at: 'asc' },
    })) as any[];
    const valuePennies = wItems.reduce((a, it) => a + Math.round(Number(it.qty) * Number(it.unit_price) * 100), 0);
    if (!wItems.length || valuePennies <= 0) {
      // Nothing valued on the card — the legacy single no-charge line (part-class: no hours, no drag).
      await tx.invoiceLine.create({
        data: {
          invoice_id: invoice.id, description: warrantyTexts.noCharge,
          qty: new Prisma.Decimal(1), unit_price: new Prisma.Decimal(0), vat_rate: new Prisma.Decimal(0),
          line_vat: new Prisma.Decimal(0), line_total: new Prisma.Decimal(0), unit_cost: new Prisma.Decimal(0),
          item_type: 'part' as any, labour_outsourced: false, position: 0,
        },
      });
      return;
    }
    // Real lines at NET retail (vat 0 on every line), then the goodwill line for −the full value:
    // the frozen lines sum to £0 by construction. The goodwill line is PART-CLASS with zero cost
    // (NEVER labour — the hours grain reads qty as hours on labour lines; classifying it labour
    // would silently add 1h of rework per warranty invoice).
    await tx.invoiceLine.createMany({
      data: [
        ...wItems.map((it, i) => ({
          invoice_id: invoice.id,
          description: it.description,
          qty: it.qty,
          unit_price: it.unit_price,
          vat_rate: new Prisma.Decimal(0),
          line_vat: new Prisma.Decimal(0),
          line_total: new Prisma.Decimal((Number(it.qty) * Number(it.unit_price)).toFixed(2)),
          unit_cost: it.unit_cost,
          catalogue_item_id: it.catalogue_item_id,
          labour_hours: it.labour_hours, // the rework-hours grain freezes with everything else
          item_type: it.item_type, labour_outsourced: !!it.labour_outsourced, // frozen classification
          position: i,
        })),
        {
          invoice_id: invoice.id,
          description: warrantyTexts.goodwill,
          qty: new Prisma.Decimal(1),
          unit_price: new Prisma.Decimal((-valuePennies / 100).toFixed(2)),
          vat_rate: new Prisma.Decimal(0),
          line_vat: new Prisma.Decimal(0),
          line_total: new Prisma.Decimal((-valuePennies / 100).toFixed(2)),
          unit_cost: new Prisma.Decimal(0),
          item_type: 'part' as any, labour_outsourced: false, // ASSERTION 1 class: no hours, no drag
          position: wItems.length,
        },
      ],
    });
    return;
  }

  const items = (await tx.jobCardItem.findMany({
    where: { job_card_id: invoice.job_card_id },
    select: { item_type: true, description: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true, vat_amount: true, catalogue_item_id: true, labour_hours: true, labour_outsourced: true },
    orderBy: { created_at: 'asc' },
  })) as any[];
  if (!items.length) return;

  const registered = !!invoice.vat_registered_at_issue;
  await tx.invoiceLine.createMany({
    data: items.map((it, i) => {
      const net = Number(it.qty) * Number(it.unit_price);
      return {
        invoice_id: invoice.id,
        description: it.description,
        qty: it.qty,
        unit_price: it.unit_price,
        vat_rate: registered ? it.vat_rate : new Prisma.Decimal(0),
        line_vat: registered ? it.vat_amount : new Prisma.Decimal(0),
        line_total: new Prisma.Decimal(net.toFixed(2)),
        unit_cost: it.unit_cost,
        catalogue_item_id: it.catalogue_item_id,
        labour_hours: it.labour_hours, // freeze the charged-hours grain with everything else
        item_type: it.item_type, labour_outsourced: !!it.labour_outsourced, // frozen classification
        position: i,
      };
    }),
  });
  /**
   * EVERY RE-FREEZE OF AN IMPORTED INVOICE MUST STILL EQUAL ITS SOURCE. 100002297 was CORRECT at
   * mint and was broken AFTERWARDS — unlocked, the card re-saved through the estimate path (which
   * deletes and recreates every line from the client payload, losing a £1,537.37 credit that was
   * absent from it), then re-frozen here at the paid transition. An assertion that fired only on
   * the first write would have watched that happen and said nothing.
   *
   * So the same equality is enforced on the re-freeze, keyed on external_ref. Throwing rolls back
   * the caller's transaction — the unlock/re-issue or the mark-paid — leaving the invoice in its
   * previous state rather than silently re-freezing a wrong one.
   */
  const imported = (await tx.invoice.findUnique({
    where: { id: invoice.id },
    select: { is_imported: true, external_ref: true, group_id: true },
  })) as { is_imported: boolean; external_ref: string | null; group_id: string } | null;
  if (imported?.is_imported && imported.external_ref) {
    const check = await assertImportedInvoiceMatchesSource(tx, {
      invoiceId: invoice.id, groupId: imported.group_id, externalRef: imported.external_ref,
    });
    if (!check.ok) throw importAssertError(imported.external_ref, check);
  }
}
