/**
 * File: lib/stock-sale.ts
 *
 * SELL A CAR — four writes, one transaction, no instant between them.
 *
 *   1. the DISPOSAL, which also freezes what the car cost (prep cards, delivery, valeting, MOT)
 *   2. OWNERSHIP moves: the old record ends, the buyer's opens
 *   3. the SALE CARD, marked sale_of_stock_item_id — never stock_item_id (see lib/stock-prep)
 *   4. the INVOICE, on the vehicle_sale series with its VAT treatment frozen
 *
 * If any of them fails, none of them happened. A disposal with no invoice and an invoice on a car
 * still in stock are not states this can leave behind — and the ORDER is enforced by code, not by
 * this comment: issueVehicleSaleInvoice refuses a car with no disposal, so the mint cannot run first.
 *
 * ── THE BUYER IS A REAL CUSTOMER ────────────────────────────────────────────────────────────────
 *
 * Picked from the books or created, like any other job. Someone who buys a car is exactly what a
 * customer is: they bring it back for servicing and their MOT reminder is a lead. A car sold to
 * somebody already on the books links to THEM, so the service history stays with the person rather
 * than starting again. The owner is never resolved from the vehicle's existing record, which for a
 * stock car is the garage's situation, not the buyer's — on the live tenant it pointed at a customer
 * row literally named "Stock" for one car and at the owner himself for another.
 *
 * ── OWNERSHIP IS ENDED AND OPENED, NOT "ENSURED" ────────────────────────────────────────────────
 *
 * lib/vehicle-identity::ensureIdentityAndCurrentOwner only writes an owner when the car has NONE. On a
 * sold car it would silently keep the previous owner: the buyer's MOT lead never appears and the
 * next service attaches to the wrong person. So the current record is ENDED here (is_current false,
 * valid_to the sale date) and the buyer's OPENED from that date; ensure… is then only asked for the
 * identity anchor, which it still owns.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordDisposalInTx } from '@/lib/stock-store';
import { issueVehicleSaleInvoice } from '@/lib/invoice-issue';
import { ensureIdentityAndCurrentOwner } from '@/lib/vehicle-identity';
import { writeAudit } from '@/lib/audit';
import { customerPhoneFields } from '@/lib/contact-routes';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import {
  buyerRefusal, isOpenPrepStatus, PICKED_BUYER_NO_ADDRESS, SALE_DATE_IN_FUTURE_REFUSAL, saleLine, saleLineDescription,
  type BuyerInput, type OpenPrepCard,
} from '@/lib/stock-sale-rules';

/** Thrown inside the transaction so the whole sale rolls back, and turned back into words outside it. */
class SaleRefused extends Error {}

/** Prep cards on this car that are still open — for the warning, never for a refusal. */
export async function openPrepCards(groupId: string, stockItemId: string): Promise<OpenPrepCard[]> {
  const cards = await prisma.jobCard.findMany({
    where: { group_id: groupId, stock_item_id: stockItemId },
    select: { id: true, status: true },
    orderBy: { created_at: 'asc' },
  });
  return cards.filter((c) => isOpenPrepStatus(String(c.status))).map((c) => ({ id: c.id, status: String(c.status) }));
}

export type SaleResult =
  | { invoiceId: string; cardId: string; disposalId: string; customerId: string }
  | { refused: string };

export type SaleDeps = {
  /**
   * THE LAST WRITE, injectable for exactly one reason: proving atomicity. car-sale-gate hands in a
   * mint that throws, and asserts that the disposal, the ownership change and the card written before
   * it all rolled back. Production never passes this.
   */
  mint?: (tx: Prisma.TransactionClient, jobCardId: string, groupId: string) => Promise<string>;
};

export async function sellCar(a: {
  groupId: string;
  userId: string;
  siteId: string;
  stockItemId: string;
  soldAt: Date;
  salePence: unknown;
  buyer: BuyerInput | null | undefined;
  note?: unknown;
}, deps: SaleDeps = {}): Promise<SaleResult> {
  // ── CHEAP REFUSALS FIRST, before any transaction is opened ─────────────────────────────────────
  const price = typeof a.salePence === 'number' ? a.salePence : Number(a.salePence);
  if (!Number.isInteger(price) || price <= 0) return { refused: 'Say what the car sold for.' };
  if (!(a.soldAt instanceof Date) || Number.isNaN(a.soldAt.getTime())) return { refused: 'Say when the car was sold.' };
  // DATE-GRAINED, UTC, like every document-date guard: a sale later today is not in the future.
  const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (utcDay(a.soldAt) > utcDay(new Date())) return { refused: SALE_DATE_IN_FUTURE_REFUSAL };
  const noBuyer = buyerRefusal(a.buyer as never);
  if (noBuyer) return { refused: noBuyer };

  const mint = deps.mint ?? issueVehicleSaleInvoice;
  const group = await prisma.group.findUnique({ where: { id: a.groupId }, select: { country_code: true, ref: true } });
  const dialCode = resolveTenantProfile(group).dialCode;

  try {
    return await prisma.$transaction(async (tx) => {
      const item = await tx.stockItem.findFirst({
        where: { id: a.stockItemId, group_id: a.groupId },
        select: {
          id: true, vat_status: true,
          vehicle: { select: { id: true, registration: true, make: true, model: true, year: true, vin: true } },
        },
      });
      if (!item) throw new SaleRefused('That stock record is not on this account.');

      // 1 ─ THE DISPOSAL. Kind is fixed: this is the sale path, and it offers nothing else.
      const disposal = await recordDisposalInTx(tx, {
        groupId: a.groupId, userId: a.userId, stockItemId: item.id,
        disposedAt: a.soldAt, kind: 'sold', salePence: price, note: a.note,
      });
      if ('refused' in disposal) throw new SaleRefused(disposal.refused);

      // 2 ─ THE BUYER, and ownership moving to them.
      const buyer = a.buyer as BuyerInput;
      let customerId: string;
      if ('customerId' in buyer) {
        const found = await tx.customer.findFirst({ where: { id: buyer.customerId, group_id: a.groupId }, select: { id: true, address: true } });
        if (!found) throw new SaleRefused('That customer is not on this account.');
        if (!found.address || !found.address.trim()) throw new SaleRefused(PICKED_BUYER_NO_ADDRESS);
        customerId = found.id;
      } else {
        const phone = customerPhoneFields(buyer.phone ?? undefined, dialCode);
        customerId = (await tx.customer.create({
          data: {
            group_id: a.groupId, site_id: a.siteId,
            name: buyer.name.trim(), address: buyer.address.trim(),
            phone: phone.phone, phone_e164: phone.phone_e164,
            email: typeof buyer.email === 'string' && buyer.email.trim() ? buyer.email.trim() : null,
          },
          select: { id: true },
        })).id;
      }
      await tx.vehicleOwnership.updateMany({
        where: { vehicle_id: item.vehicle.id, is_current: true },
        data: { is_current: false, valid_to: a.soldAt },
      });
      await tx.vehicleOwnership.create({
        data: { vehicle_id: item.vehicle.id, customer_id: customerId, is_current: true, valid_from: a.soldAt },
      });
      // The identity anchor only — the owner record above already exists, so this cannot touch it.
      await ensureIdentityAndCurrentOwner(tx, {
        vehicleId: item.vehicle.id, groupId: a.groupId, customerId,
        registration: item.vehicle.registration, vin: item.vehicle.vin,
      });

      // 3 ─ THE SALE CARD. One line, built for the scheme (lib/stock-sale-rules::saleLine).
      const line = saleLine(price, item.vat_status);
      const card = await tx.jobCard.create({
        data: {
          group_id: a.groupId, site_id: a.siteId, customer_id: customerId, vehicle_id: item.vehicle.id,
          status: 'invoiced', sale_of_stock_item_id: item.id,
          items: { create: [{
            item_type: 'misc', description: saleLineDescription(item.vehicle),
            qty: 1, unit_price: line.unitPricePounds, vat_rate: line.vatRate, vat_amount: line.vatAmountPounds,
            unit_cost: null,
          }] },
        },
        select: { id: true },
      });

      // 4 ─ THE INVOICE. Last, and it refuses to run on a car with no disposal.
      const invoiceId = await mint(tx, card.id, a.groupId);

      await writeAudit(tx, {
        groupId: a.groupId, userId: a.userId, jobCardId: card.id, action: 'stock.sold',
        diff: { stockItemId: item.id, disposalId: disposal.id, invoiceId, customerId, salePence: price, soldAt: a.soldAt.toISOString() },
      });
      return { invoiceId, cardId: card.id, disposalId: disposal.id, customerId };
    }, { maxWait: 10_000, timeout: 30_000 });
  } catch (e) {
    if (e instanceof SaleRefused) return { refused: e.message };
    const msg = e instanceof Error ? e.message : String(e);
    // The mint's own refusals carry this prefix; they are words for a person, not a crash.
    if (msg.startsWith('IMPORT_ASSERT:')) return { refused: msg.slice('IMPORT_ASSERT:'.length) };
    throw e;
  }
}
