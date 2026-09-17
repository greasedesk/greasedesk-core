/**
 * File: lib/stock-historical.ts
 *
 * RECORD A CAR SOLD BEFORE GREASEDESK INVOICED CAR SALES — bought, prepared and sold, in one transaction.
 *
 * The rules and the words are in lib/stock-historical-rules; this is the writer. It is the ONLY writer
 * of StockDisposal.recorded_not_invoiced = true.
 *
 *   1. the STOCK ITEM, with its stock number, seller and purchase reference
 *   2. its COSTS, one row per supplier bill, dated, with the VAT treatment on the bill
 *   3. the BUYER as a customer, when the paperwork names one
 *   4. the DISPOSAL, marked recorded-not-invoiced with the receipt number, which FREEZES the costs
 *      through the same freeze a live sale uses (so the car's cost is what its bills say, net as the
 *      live page would show it)
 *   5. OWNERSHIP to the buyer from the sale date — added, never rewritten
 *
 * NOTHING IS MINTED. No sale card, no invoice, no counter other than the stock number. The VAT screen
 * starts from invoices, so a recorded sale cannot reach a VAT figure; it is COUNTED there and stated as
 * left out, which is a separate reader.
 *
 * ── REFUSALS BEFORE WRITES ──────────────────────────────────────────────────────────────────────
 *
 * Everything that can be decided without writing is decided first — the paperwork, the boundary, the
 * owners and the stock periods — so a refused entry leaves nothing behind. The owner and stock-period
 * checks run inside the transaction, where nothing can move between the check and the write. The one
 * row that can precede a refusal is the vehicle for a registration GreaseDesk has never seen — created
 * as normal intake creates it, and a car nobody has seen has no owners or stock history to refuse on.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { customerPhoneFields } from '@/lib/contact-routes';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { ensureIdentityAndCurrentOwner } from '@/lib/vehicle-identity';
import { findOrCreateVehicle, findVehicleByReg, recordDisposalInTx, recordIntakeMileage, takeIntoStockInTx, vinCollision } from '@/lib/stock-store';
import { vinAtIntake, parseMiles } from '@/lib/stock-intake';
import { recordOdometerReadings } from '@/lib/odometer';
import { isHistoricalCostKind, isVatTreatment } from '@/lib/stock-cost';
import {
  PURCHASE_PAPERWORK_KEYS, SALE_PAPERWORK_KEYS, checkPaperwork,
} from '@/lib/stock-paperwork';
import {
  HELD_OVERLAP_REFUSAL, HISTORICAL_NO_BOUNDARY_REFUSAL, boundaryRefusal, effectiveBoundary, historicalBasicsRefusal,
  laterOwners, moveEarlierRefusal, overlapsHeld, ownershipConflicts, ownershipRefusal, ownershipWrite,
  type Boundary, type OwnerEdge,
} from '@/lib/stock-historical-rules';

class Refused extends Error {}

export type HistoricalCostInput = {
  kind: unknown; description: unknown; amountPence: unknown; incurredOn: Date | null; vatTreatment: unknown;
};

export type HistoricalSaleInput = {
  groupId: string; userId: string; siteId: string;
  registration: unknown; make?: unknown; model?: unknown;
  acquiredAt: Date | null; arrivedAt?: Date | null;
  purchasePence: unknown; premiumPence?: unknown; servicesPence?: unknown;
  vatStatus: unknown; source: unknown;
  sellerName?: unknown; purchaseRef?: unknown; mileageMiles?: unknown;
  /** The car's description on the paperwork. Fill a blank on an existing car; never overwrite one. */
  vin?: unknown; colour?: unknown;
  /** The mileage on the sales receipt — a reading under source `sale`, on the sale date. */
  saleMileageMiles?: unknown;
  soldAt: Date | null; salePence: unknown;
  /** A customer already on the books, a new one, or NULL when the paperwork names nobody (ticked). */
  buyer: { customerId: string } | { name: unknown; address?: unknown; phone?: unknown; email?: unknown } | null;
  receiptRef?: unknown;
  notOnPaperwork: { purchase: unknown; sale: unknown };
  costs: HistoricalCostInput[];
  note?: unknown;
  now?: Date;
};

export type HistoricalSaleResult =
  | { stockItemId: string; disposalId: string; stockNumber: number; customerId: string | null }
  | { refused: string };

const text = (v: unknown, cap = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null;

/** The tenant's first car sale invoiced through GreaseDesk, dated by its sale — the second limit. */
async function firstInvoicedSale(groupId: string): Promise<{ date: Date; invoiceNumber: string } | null> {
  const first = await prisma.invoice.findFirst({
    where: { group_id: groupId, series: 'vehicle_sale' },
    orderBy: { sequence_value: 'asc' },
    select: { invoice_number: true, stock_disposal_id: true, date_issued: true },
  });
  if (!first) return null;
  const disposal = first.stock_disposal_id
    ? await prisma.stockDisposal.findFirst({ where: { id: first.stock_disposal_id, group_id: groupId }, select: { disposed_at: true } })
    : null;
  // The invoice is dated BY the disposal (lib/invoice-issue), so these agree; the disposal is the fact.
  const date = disposal?.disposed_at ?? first.date_issued;
  if (!date) return null;
  return { date, invoiceNumber: first.invoice_number ?? '' };
}

/** THE EFFECTIVE BOUNDARY: NULL until declared; then the earlier of the declaration and the first invoiced sale. */
export async function historicalBoundary(groupId: string): Promise<Boundary | null> {
  const g = await prisma.group.findUnique({ where: { id: groupId }, select: { car_sales_invoiced_from: true } });
  return effectiveBoundary(g?.car_sales_invoiced_from ?? null, await firstInvoicedSale(groupId));
}

const utcToday = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * DECLARE THE BOUNDARY — stamped with today, written once. The update is conditional on the column still
 * being NULL, so two declarations at once cannot both write: the second finds it set and refuses.
 */
export async function declareCarSalesBoundary(a: { groupId: string; userId: string; now?: Date }): Promise<{ date: Date } | { refused: string }> {
  const today = utcToday(a.now ?? new Date());
  return prisma.$transaction(async (tx) => {
    const u = await tx.group.updateMany({ where: { id: a.groupId, car_sales_invoiced_from: null }, data: { car_sales_invoiced_from: today } });
    if (u.count !== 1) {
      const g = await tx.group.findUnique({ where: { id: a.groupId }, select: { car_sales_invoiced_from: true } });
      return { refused: g?.car_sales_invoiced_from
        ? `The boundary was already declared: sales before ${g.car_sales_invoiced_from.toISOString().slice(0, 10)}. It can only be moved earlier.`
        : 'That account could not be found.' };
    }
    await writeAudit(tx, { groupId: a.groupId, userId: a.userId, entity: 'group', entityId: a.groupId,
      action: 'stock.boundary_declared', diff: { carSalesInvoicedFrom: today.toISOString().slice(0, 10) } });
    return { date: today };
  });
}

/** MOVE THE DECLARATION EARLIER — never later, never past a sale already recorded as history. */
export async function moveCarSalesBoundaryEarlier(a: { groupId: string; userId: string; date: Date | null; now?: Date }): Promise<{ date: Date } | { refused: string }> {
  const now = a.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const g = await tx.group.findUnique({ where: { id: a.groupId }, select: { car_sales_invoiced_from: true } });
    const proposed = a.date ? utcToday(a.date) : null;
    const recorded = proposed ? await tx.stockDisposal.findMany({
      where: { group_id: a.groupId, recorded_not_invoiced: true, disposed_at: { gte: proposed } },
      select: { disposed_at: true, stock_item: { select: { vehicle: { select: { registration: true } } } } },
      orderBy: { disposed_at: 'asc' },
    }) : [];
    const refused = moveEarlierRefusal({
      current: g?.car_sales_invoiced_from ?? null, proposed, now,
      recordedOnOrAfter: recorded.map((r) => `${r.stock_item.vehicle.registration} (${r.disposed_at.toISOString().slice(0, 10)})`),
    });
    if (refused) return { refused };
    const u = await tx.group.updateMany({
      where: { id: a.groupId, car_sales_invoiced_from: g!.car_sales_invoiced_from }, data: { car_sales_invoiced_from: proposed },
    });
    if (u.count !== 1) return { refused: 'The boundary changed while this was being saved. Look again and retry.' };
    await writeAudit(tx, { groupId: a.groupId, userId: a.userId, entity: 'group', entityId: a.groupId, action: 'stock.boundary_moved_earlier',
      diff: { from: g!.car_sales_invoiced_from!.toISOString().slice(0, 10), to: proposed!.toISOString().slice(0, 10) } });
    return { date: proposed! };
  });
}

async function ownerEdges(db: Prisma.TransactionClient | typeof prisma, vehicleId: string): Promise<OwnerEdge[]> {
  const rows = await db.vehicleOwnership.findMany({
    where: { vehicle_id: vehicleId },
    select: { customer_id: true, valid_from: true, valid_to: true, is_current: true, customer: { select: { name: true } } },
    orderBy: { valid_from: 'asc' },
  });
  return rows.map((r) => ({ customerId: r.customer_id, customerName: r.customer?.name ?? '—', validFrom: r.valid_from, validTo: r.valid_to, isCurrent: r.is_current }));
}

async function heldPeriods(db: Prisma.TransactionClient | typeof prisma, groupId: string, vehicleId: string) {
  const rows = await db.stockItem.findMany({
    where: { group_id: groupId, vehicle_id: vehicleId },
    select: { acquired_at: true, disposal: { select: { disposed_at: true } } },
  });
  return rows.map((r) => ({ acquiredAt: r.acquired_at, disposedAt: r.disposal?.disposed_at ?? null }));
}

export async function recordHistoricalSale(a: HistoricalSaleInput): Promise<HistoricalSaleResult> {
  // ── 1. CHEAP REFUSALS: money, dates, scheme, source ────────────────────────────────────────────
  const basics = historicalBasicsRefusal({
    registration: a.registration, acquiredAt: a.acquiredAt, soldAt: a.soldAt,
    purchasePence: a.purchasePence, salePence: a.salePence, vatStatus: a.vatStatus, source: a.source, now: a.now,
  });
  if (basics) return { refused: basics };
  const acquiredAt = a.acquiredAt as Date;
  const soldAt = a.soldAt as Date;

  // ── 2. THE PAPERWORK: every field filled or ticked, never both, never silent ──────────────────
  const make = text(a.make, 60);
  const model = text(a.model, 60);
  const purchaseRefusal = checkPaperwork(PURCHASE_PAPERWORK_KEYS, {
    seller_name: a.sellerName, purchase_ref: a.purchaseRef,
    mileage: typeof a.mileageMiles === 'number' ? a.mileageMiles : (text(a.mileageMiles) ?? undefined),
    make_model: make && model ? `${make} ${model}` : undefined,
    vin: a.vin, colour: a.colour,
  }, a.notOnPaperwork?.purchase);
  if (purchaseRefusal) return { refused: purchaseRefusal };
  const picked = a.buyer && 'customerId' in a.buyer ? a.buyer.customerId : null;
  const newBuyer = a.buyer && !('customerId' in a.buyer) ? a.buyer : null;
  const saleTicks = a.notOnPaperwork?.sale;
  if (picked && Array.isArray(saleTicks)) {
    const unknownTick = saleTicks.find((t) => !(SALE_PAPERWORK_KEYS as readonly unknown[]).includes(t));
    if (unknownTick !== undefined) return { refused: `“${String(unknownTick)}” is not a field that can be marked as not on the paperwork here.` };
  }
  // A PICKED customer's name is on the books; their address is checked once they are read, below.
  const saleMileageValue = typeof a.saleMileageMiles === 'number' ? a.saleMileageMiles : (text(a.saleMileageMiles) ?? undefined);
  const saleRefusal = checkPaperwork(picked ? ['receipt_ref', 'sale_mileage'] : SALE_PAPERWORK_KEYS, {
    buyer_name: newBuyer?.name, buyer_address: newBuyer?.address, receipt_ref: a.receiptRef, sale_mileage: saleMileageValue,
  }, picked && Array.isArray(saleTicks) ? saleTicks.filter((t) => t === 'receipt_ref' || t === 'sale_mileage') : saleTicks);
  if (saleRefusal) return { refused: saleRefusal };
  if (picked && Array.isArray(saleTicks) && saleTicks.includes('buyer_name')) {
    return { refused: 'A customer is picked as the buyer AND the buyer is ticked as not on the paperwork. One of those is wrong.' };
  }
  const ticksSale = (Array.isArray(saleTicks) ? saleTicks : []) as string[];

  // ── 2b. THE CAR'S DESCRIPTION AND THE TWO MILEAGES, checked before anything is written ──────────
  const vin = vinAtIntake(a.vin);
  if ('refused' in vin) return { refused: vin.refused };
  const colour = text(a.colour, 40);
  const purchaseMiles = parseMiles(a.mileageMiles);
  if ('refused' in purchaseMiles) return { refused: `Mileage at purchase: ${purchaseMiles.refused}` };
  const saleMiles = parseMiles(a.saleMileageMiles);
  if ('refused' in saleMiles) return { refused: `Mileage at sale: ${saleMiles.refused}` };
  if (purchaseMiles.miles !== null && saleMiles.miles !== null && saleMiles.miles < purchaseMiles.miles) {
    return { refused: `The mileage at sale (${saleMiles.miles}) is lower than at purchase (${purchaseMiles.miles}). One of them is wrong — check the paperwork.` };
  }

  // ── 3. THE COSTS, each a supplier bill ────────────────────────────────────────────────────────
  const costs: { kind: string; description: string; amountPence: number; incurredOn: Date; vatTreatment: string }[] = [];
  for (const [i, c] of (Array.isArray(a.costs) ? a.costs : []).entries()) {
    const n = i + 1;
    if (!isHistoricalCostKind(c.kind)) return { refused: `Cost ${n}: say what kind of cost this is.` };
    if (!isVatTreatment(c.vatTreatment)) return { refused: `Cost ${n}: say how the supplier charged VAT on it.` };
    if (!(c.incurredOn instanceof Date) || Number.isNaN(c.incurredOn.getTime())) {
      return { refused: `Cost ${n}: say when you paid it. The date is what puts it in a period.` };
    }
    if (c.incurredOn.getTime() > soldAt.getTime() + 86_400_000) {
      return { refused: `Cost ${n} is dated after the car was sold. A bill for a car you no longer had is not its cost.` };
    }
    const amount = Number(c.amountPence);
    if (!Number.isInteger(amount) || amount <= 0) return { refused: `Cost ${n}: say how much it cost.` };
    const description = text(c.description);
    if (!description) return { refused: `Cost ${n}: say what it was for — a figure with no description is unauditable.` };
    costs.push({ kind: String(c.kind), description, amountPence: amount, incurredOn: c.incurredOn, vatTreatment: String(c.vatTreatment) });
  }

  // ── 4. THE BOUNDARY ────────────────────────────────────────────────────────────────────────────
  const boundary = await historicalBoundary(a.groupId);
  if (!boundary) return { refused: HISTORICAL_NO_BOUNDARY_REFUSAL };
  const late = boundaryRefusal(soldAt, boundary);
  if (late) return { refused: late };

  // ── 5. THE PICKED BUYER, READ ──────────────────────────────────────────────────────────────────
  let pickedCustomer: { id: string; name: string; address: string | null } | null = null;
  if (picked) {
    pickedCustomer = await prisma.customer.findFirst({ where: { id: picked, group_id: a.groupId }, select: { id: true, name: true, address: true } });
    if (!pickedCustomer) return { refused: 'That customer is not on this account.' };
    const hasAddress = !!pickedCustomer.address?.trim();
    const ticked = ticksSale.includes('buyer_address');
    if (!hasAddress && !ticked) {
      return { refused: 'That customer has no address on file. Add it to the customer, or tick “not on the paperwork” if the receipt did not carry one.' };
    }
    if (hasAddress && ticked) {
      return { refused: 'That customer has an address on file AND the address is ticked as not on the paperwork. Untick it — the book will print the address the customer holds today.' };
    }
  }

  // ── 6. THE CAR: owners and stock periods, read, before anything is written ─────────────────────
  const registration = String(a.registration).trim().toUpperCase();
  // The owner and stock-period checks are made ONCE, inside the transaction below. A copy out here was
  // red-proved invisible — deleting it changed no clause — and it saved no write: a car with owners or
  // stock history already exists, so nothing would be created before the refusal.
  const known = await findVehicleByReg(a.groupId, registration);
  // A car GreaseDesk has never seen is created with its VIN, as normal intake creates one. A KNOWN car is only
  // touched inside the transaction, after its owners are checked — a refused entry changes nothing about it.
  const vehicle = known ?? await findOrCreateVehicle({ groupId: a.groupId, registration, make, model, acquiredAt, vin: vin.vin });
  if ('refused' in vehicle) return vehicle;

  const group = await prisma.group.findUnique({ where: { id: a.groupId }, select: { country_code: true, ref: true } });
  const dialCode = resolveTenantProfile(group).dialCode;
  const purchaseTicks = (Array.isArray(a.notOnPaperwork?.purchase) ? a.notOnPaperwork.purchase : []) as string[];

  try {
    const out = await prisma.$transaction(async (tx) => {
      // INSIDE the transaction, so nothing can change between the check and the write.
      const edges = await ownerEdges(tx, vehicle.id);
      const conflicts = ownershipConflicts(edges, acquiredAt, soldAt);
      if (conflicts.length) throw new Refused(ownershipRefusal(conflicts));
      if (overlapsHeld(await heldPeriods(tx, a.groupId, vehicle.id), acquiredAt, soldAt)) throw new Refused(HELD_OVERLAP_REFUSAL);

      // 0 ─ THE CAR'S DESCRIPTION: fill what is blank, never overwrite what is there. A different VIN is a
      // different car and refuses; a different colour is left as recorded (a respray, or DVLA's word for it).
      const car = await tx.vehicle.findUnique({ where: { id: vehicle.id }, select: { vin_normalized: true, colour: true, registration: true } });
      const fill: Record<string, string> = {};
      if (vin.vin) {
        if (car?.vin_normalized && car.vin_normalized !== vin.vin) {
          throw new Refused(`${car.registration} is already recorded with a different VIN. A past sale does not get to change which car this is — fix it on the vehicle record if the stored one is wrong.`);
        }
        const clash = await vinCollision(a.groupId, vin.vin, vehicle.id);
        if (clash) throw new Refused(clash.refused);
        if (!car?.vin_normalized) { fill.vin = vin.vin; fill.vin_normalized = vin.vin; }
      }
      if (colour && !car?.colour) fill.colour = colour;
      if (Object.keys(fill).length) await tx.vehicle.update({ where: { id: vehicle.id }, data: fill });

      // 1 ─ THE STOCK ITEM, through the one intake writer, with its stock number.
      const item = await takeIntoStockInTx(tx, {
        groupId: a.groupId, userId: a.userId, vehicleId: vehicle.id, acquiredAt,
        purchasePence: a.purchasePence, vatStatus: a.vatStatus, source: a.source,
        premiumPence: a.premiumPence, servicesPence: a.servicesPence,
        arrivedAt: a.arrivedAt ?? null,
        sellerName: text(a.sellerName), purchaseRef: text(a.purchaseRef, 100),
        notOnPaperwork: purchaseTicks,
      });
      if ('refused' in item) throw new Refused(item.refused);

      // 2 ─ THE COSTS, before the disposal that freezes them.
      for (const c of costs) {
        await tx.stockCost.create({
          data: {
            group_id: a.groupId, stock_item_id: item.id, created_by_user_id: a.userId,
            kind: c.kind, description: c.description, amount_pence: c.amountPence,
            incurred_on: c.incurredOn, vat_treatment: c.vatTreatment, reverses_id: null,
          },
        });
      }

      // 3 ─ THE BUYER, when the paperwork names one.
      let customerId: string | null = null;
      let buyerName: string | null = null;
      let buyerAddress: string | null = null;
      if (pickedCustomer) {
        customerId = pickedCustomer.id;
        buyerName = pickedCustomer.name;
        buyerAddress = pickedCustomer.address;
      } else if (newBuyer && text(newBuyer.name)) {
        const phone = customerPhoneFields(text(newBuyer.phone) ?? undefined, dialCode);
        buyerName = text(newBuyer.name);
        buyerAddress = text(newBuyer.address, 500);
        customerId = (await tx.customer.create({
          data: {
            group_id: a.groupId, site_id: a.siteId, name: buyerName as string, address: buyerAddress,
            phone: phone.phone, phone_e164: phone.phone_e164, email: text(newBuyer.email),
          },
          select: { id: true },
        })).id;
      } else if (newBuyer) {
        // No name on the paperwork: nobody to make a customer of. An address alone is still the book's.
        buyerAddress = text(newBuyer.address, 500);
      }

      // 4 ─ THE DISPOSAL, marked, which freezes what the car cost.
      const disposal = await recordDisposalInTx(tx, {
        groupId: a.groupId, userId: a.userId, stockItemId: item.id,
        disposedAt: soldAt, kind: 'sold', salePence: Number(a.salePence), note: a.note,
        buyer: { customerId, name: buyerName, address: buyerAddress },
        notInvoiced: { receiptRef: text(a.receiptRef, 100) },
        notOnPaperwork: ticksSale,
      });
      if ('refused' in disposal) throw new Refused(disposal.refused);

      // 5 ─ OWNERSHIP, ADDED BESIDE WHAT IS THERE. Nothing overlapping our holding exists (checked above);
      // an owner from after the sale is left exactly as recorded (lib/stock-historical-rules::ownershipWrite).
      const own = ownershipWrite(customerId, laterOwners(edges, soldAt));
      if (own.kind === 'ended') {
        await tx.vehicleOwnership.create({
          data: { vehicle_id: vehicle.id, customer_id: customerId as string, is_current: false, valid_from: soldAt, valid_to: own.validTo },
        });
      } else if (own.kind === 'current' && customerId) {
        await tx.vehicleOwnership.create({
          data: { vehicle_id: vehicle.id, customer_id: customerId, is_current: true, valid_from: soldAt },
        });
        // The car's OWN vin: passing null would blank vin_normalized on a car with no identity yet.
        const v = await tx.vehicle.findUnique({ where: { id: vehicle.id }, select: { vin: true, registration: true } });
        await ensureIdentityAndCurrentOwner(tx, {
          vehicleId: vehicle.id, groupId: a.groupId, customerId, registration: v?.registration ?? registration, vin: v?.vin ?? null,
        });
      }

      await writeAudit(tx, {
        groupId: a.groupId, userId: a.userId, entity: 'stock_item', entityId: item.id,
        action: 'stock.recorded_historical',
        diff: {
          disposalId: disposal.id, stockNumber: item.stockNumber, customerId,
          acquiredAt: acquiredAt.toISOString(), soldAt: soldAt.toISOString(),
          purchasePence: Number(a.purchasePence), salePence: Number(a.salePence), costs: costs.length,
          notOnPaperwork: { purchase: purchaseTicks, sale: ticksSale },
          ownership: own.kind === 'none' ? own.why : own.kind,
        },
      });
      return { stockItemId: item.id, disposalId: disposal.id, stockNumber: item.stockNumber, customerId };
    }, { maxWait: 10_000, timeout: 30_000 });

    await recordIntakeMileage({ groupId: a.groupId, vehicleId: vehicle.id, acquiredAt, mileageMiles: a.mileageMiles });
    // AFTER the commit, like the purchase reading: a reading is a fact about the car, not part of the sale.
    if (saleMiles.miles !== null) {
      await recordOdometerReadings(prisma, { groupId: a.groupId, vehicleId: vehicle.id, source: 'sale', readings: [{ date: soldAt, miles: saleMiles.miles }] });
    }
    return out;
  } catch (e) {
    if (e instanceof Refused) return { refused: e.message };
    throw e;
  }
}
