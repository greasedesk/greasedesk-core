/**
 * File: lib/invoice-issue.ts
 * ISSUE + FREEZE chokepoints for the one-object invoice model. The invoice IS the card's line
 * items under an assigned number:
 *
 *  issueInvoiceForCard          → mint a CHARGEABLE number + header snapshot. NO line copy — while
 *                                 `issued`, renderers read the card's live items, so a job that
 *                                 grows after invoicing updates the bill under the same number.
 *  issueWarrantyInvoiceForCard  → the comeback path: mint from the independent WARRANTY counter,
 *                                 same header snapshot, £0 document (single no-charge line at paid).
 *  snapshotPaidLines            → the freeze: copy the card's items into InvoiceLine at PAID (the
 *                                 immutable income grain). Warranty invoices freeze as ONE
 *                                 "no charge" £0 line, never itemised. Idempotent (replaces any
 *                                 previous snapshot — used by re-pay after an ADMIN unlock).
 *
 * All run inside the caller's tx (a minted number rolls back with a failed issue). Sticky:
 * one-per-card (Invoice.job_card_id @unique) — re-entering `invoiced` never re-mints.
 */
import { Prisma } from '@prisma/client';
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

export function issueInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string): Promise<string> {
  return createInvoiceRow(tx, jobCardId, groupId, 'chargeable');
}

export function issueWarrantyInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string): Promise<string> {
  return createInvoiceRow(tx, jobCardId, groupId, 'warranty');
}

/**
 * Freeze the invoice's lines at PAID. Chargeable → snapshot the card's items (VAT gated by the
 * tenant's registration AT ISSUE, keeping the snapshot consistent with vat_registered_at_issue).
 * Warranty → one "no charge" £0 line (ruling: never itemised). `warrantyLineText` is resolved by
 * the caller (site-locale i18n) — this chokepoint doesn't reach into translation files.
 */
export async function snapshotPaidLines(
  tx: Prisma.TransactionClient,
  invoice: { id: string; job_card_id: string; series: 'chargeable' | 'warranty' | string; vat_registered_at_issue: boolean },
  warrantyLineText: string,
): Promise<void> {
  await tx.invoiceLine.deleteMany({ where: { invoice_id: invoice.id } }); // idempotent re-freeze (re-pay after unlock)

  if (invoice.series === 'warranty') {
    await tx.invoiceLine.create({
      data: {
        invoice_id: invoice.id,
        description: warrantyLineText,
        qty: new Prisma.Decimal(1),
        unit_price: new Prisma.Decimal(0),
        vat_rate: new Prisma.Decimal(0),
        line_vat: new Prisma.Decimal(0),
        line_total: new Prisma.Decimal(0),
        unit_cost: new Prisma.Decimal(0),
        position: 0,
      },
    });
    return;
  }

  const items = (await tx.jobCardItem.findMany({
    where: { job_card_id: invoice.job_card_id },
    select: { description: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true, vat_amount: true, catalogue_item_id: true },
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
        position: i,
      };
    }),
  });
}
