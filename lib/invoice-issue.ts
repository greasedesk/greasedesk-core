/**
 * File: lib/invoice-issue.ts
 * The ISSUE transition: turn a job card's quote into an Invoice. Runs inside the caller's tx (so the
 * minted number rolls back with the whole issue on failure). Sticky: caller checks one-per-card
 * first (Invoice.job_card_id is @unique), so re-entering `invoiced` never re-mints. Copies quote
 * lines into InvoiceLine (snapshot, not a shared FK — the card keeps its own lines) and captures the
 * header snapshot (resolved company identity + customer + vehicle + registration flag at issue).
 */
import { Prisma } from '@prisma/client';
import { assignInvoiceNumber, formatInvoiceNumber } from '@/lib/invoice-number';
import { resolveCompanyIdentity } from '@/lib/invoice';

export async function issueInvoiceForCard(tx: Prisma.TransactionClient, jobCardId: string, groupId: string): Promise<string> {
  const card = (await tx.jobCard.findUnique({
    where: { id: jobCardId },
    select: {
      site_id: true,
      group: { select: { group_name: true, company_number: true, vat_number: true, address: true, vat_registered: true, invoice_prefix: true, invoice_pad_width: true } },
      site: { select: { company_number: true, vat_number: true, address: true } },
      customer: { select: { name: true, address: true } },
      vehicle: { select: { registration: true, make: true, model: true } },
      items: { select: { description: true, qty: true, unit_price: true, unit_cost: true, vat_rate: true, vat_amount: true }, orderBy: { created_at: 'asc' } },
    },
  })) as any;
  if (!card) throw new Error('CARD_NOT_FOUND');

  const identity = resolveCompanyIdentity(card.group, card.site);
  const seq = await assignInvoiceNumber(tx, groupId); // mint (concurrency-safe; rolls back with this tx)
  const number = formatInvoiceNumber({ prefix: card.group.invoice_prefix, padWidth: card.group.invoice_pad_width }, seq);
  const vehicleDesc = [card.vehicle?.make, card.vehicle?.model].filter(Boolean).join(' ') || null;

  const invoice = await tx.invoice.create({
    data: {
      group_id: groupId,
      job_card_id: jobCardId,
      site_id: card.site_id,
      status: 'issued',
      sequence_value: seq,
      invoice_number: number,
      issued_at: new Date(),
      company_name_snapshot: identity.name,
      company_vat_number_snapshot: identity.vatNumber,
      company_address_snapshot: identity.address,
      customer_name_snapshot: card.customer?.name ?? '',
      customer_address_snapshot: card.customer?.address ?? null,
      vehicle_reg_snapshot: card.vehicle?.registration ?? null,
      vehicle_desc_snapshot: vehicleDesc,
      vat_registered_at_issue: !!card.group.vat_registered,
    },
    select: { id: true },
  });

  // Snapshot-copy the quote lines. line_total = ex-VAT (qty×unit_price). VAT is gated by the tenant's
  // registration AT ISSUE — if the tenant de-registered since the quote, the invoice carries no VAT
  // (keeps the snapshot internally consistent with vat_registered_at_issue).
  const registered = !!card.group.vat_registered;
  if (card.items.length) {
    await tx.invoiceLine.createMany({
      data: card.items.map((it: any, i: number) => {
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
          position: i,
        };
      }),
    });
  }

  return invoice.id;
}
