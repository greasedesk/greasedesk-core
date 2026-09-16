/**
 * File: lib/stock-store.ts
 * THE ONE WRITER for stock, and the one reader of the book. Every scope is tenant-checked here rather
 * than by each caller — the same shape as lib/purchase-model-store.
 */
import { prisma } from '@/lib/db';
import {
  DISPOSAL_KINDS, bookRow, daysInStock, daysOnForecourt, hasSalePrice, isStockStatus, sectionFor,
  vatPositionFor, type BookRow, type DisposalKind, type StockStatus,
} from '@/lib/stock';
import { SOURCES, VAT_STATUSES, type PurchaseSource, type VatStatus } from '@/lib/purchase-model';
import {
  firstRegisteredRefusal, motExpiryDecision, normaliseV5c, parseImportStatus, parseMiles,
  parseWarranted, vinAtIntake,
} from '@/lib/stock-intake';
import { recordOdometerReadings } from '@/lib/odometer';
import {
  groupPrepLines, prepCost, type PrepCardGroup, type PrepCost,
} from '@/lib/stock-prep';
import { projectStock, type Projection } from '@/lib/stock-projection';
import { summariseSold, type SoldRow, type SoldSummary } from '@/lib/stock-sold';
import {
  CREDIT_AFTER_DISPOSAL_REFUSAL, checkCredit, isStockCostKind, isVatTreatment, netCosts,
  type CostRow, type CostTotals,
} from '@/lib/stock-cost';
import {
  MUST_CHOOSE_REFUSAL, isReacquisition, reacquisitionCostBase, type PriorSale,
} from '@/lib/stock-reacquisition';

const asMoney = (v: unknown, cap = 100000000): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(cap, Math.round(n)) : 0;
};

/** Bring a car into stock. The row IS the assertion of ownership; no ownership edge is written. */
export async function takeIntoStock(a: {
  groupId: string; userId: string; vehicleId: string; acquiredAt: Date;
  purchasePence: unknown; vatStatus: unknown; source: unknown;
  premiumPence?: unknown; servicesPence?: unknown;
  /** The reading off the purchase invoice, and whether the seller stood behind it. */
  mileageMiles?: unknown; mileageWarranted?: unknown;
  /** Set ONLY when the person said this is a return or a buyback — never inferred from a match. */
  reacquiredFromDisposalId?: string | null;
  /** Where it starts. A car bought at auction for Friday collection starts `due_in`, not in prep. */
  status?: unknown;
  /** When it turned up. NULL for a due-in car — see lib/stock::stockClock. */
  arrivedAt?: Date | null;
}): Promise<{ id: string; creditableInvoiceId?: string | null } | { refused: string }> {
  // THE CAR MUST BE THIS TENANT'S. Checked here because this is the door, not in each caller.
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: a.vehicleId, group_id: a.groupId }, select: { id: true },
  });
  if (!vehicle) return { refused: 'That vehicle is not on this account.' };

  // ONE LIVE STOCK RECORD PER CAR. A second would make "is this in stock?" a question with two
  // answers. Not a database constraint: a car legitimately comes back — bought, sold, bought again —
  // so the rule is "no UNDISPOSED record", which no UNIQUE index can express.
  const open = await prisma.stockItem.findFirst({
    where: { group_id: a.groupId, vehicle_id: a.vehicleId, disposal: { is: null } },
    select: { id: true },
  });
  if (open) return { refused: 'That car is already in stock. Record its disposal before buying it again.' };

  const vatStatus = (VAT_STATUSES as readonly string[]).includes(String(a.vatStatus))
    ? (a.vatStatus as VatStatus) : null;
  if (!vatStatus) return { refused: 'Say whether this car is on the margin scheme or VAT qualifying.' };
  const source = (SOURCES as readonly string[]).includes(String(a.source))
    ? (a.source as PurchaseSource) : null;
  if (!source) return { refused: 'Say where the car came from.' };

  /**
   * ── A CAR THAT HAS BEEN HERE BEFORE ───────────────────────────────────────────────────────────
   *
   * The cost base is decided by lib/stock-reacquisition and nowhere else. Note what this does NOT do:
   * it never looks up a prior sale in order to CHOOSE the source. The source arrives already chosen by
   * a person, and the prior sale is fetched only to obey the choice they made.
   */
  let purchasePence = asMoney(a.purchasePence);
  let vatStatusFinal: string = vatStatus;
  let creditableInvoiceId: string | null = null;

  if (isReacquisition(source)) {
    const prior = a.reacquiredFromDisposalId
      ? await priorSaleByDisposal(a.groupId, a.reacquiredFromDisposalId)
      : null;
    if (a.reacquiredFromDisposalId && !prior) {
      return { refused: 'That earlier sale is not on this account.' };
    }
    const base = reacquisitionCostBase({
      source, prior, enteredPence: purchasePence, enteredVatStatus: vatStatus,
    });
    if ('refused' in base) return base;
    purchasePence = base.purchasePence;
    vatStatusFinal = base.vatStatus;
    // The invoice the surface may OFFER to credit. Offered, never minted here: a credit note picks a
    // VAT tax point, and that date is confirmed by a person (lib/credit-note, the two clocks).
    if (source === 'return') creditableInvoiceId = prior?.invoiceId ?? null;
  } else if (a.reacquiredFromDisposalId) {
    // A LINK WITHOUT A SOURCE TO MATCH IT. Refused rather than dropped: somebody has said this car
    // came back AND said it came from an auction, and one of those is wrong.
    return { refused: MUST_CHOOSE_REFUSAL };
  }

  const row = await prisma.stockItem.create({
    data: {
      group_id: a.groupId, vehicle_id: a.vehicleId, created_by_user_id: a.userId,
      acquired_at: a.acquiredAt,
      purchase_pence: purchasePence,
      // CAPTURED AT PURCHASE. Never re-read from the tenant's profile: a margin car stays a margin car.
      vat_status: vatStatusFinal, source,
      reacquired_from_disposal_id: a.reacquiredFromDisposalId ?? null,
      premium_pence: asMoney(a.premiumPence), services_pence: asMoney(a.servicesPence),
      // A TERM OF THIS SALE, not a fact about the car — see the schema comment for why it lives here.
      mileage_warranted: parseWarranted(a.mileageWarranted),
      /**
       * EXPLICIT FROM THE START. Defaulted to in_prep rather than guessed from whether an arrival date
       * was given: a person taking a car in says which it is, and deriving it would be the inference
       * this column exists to avoid. An unrecognised value falls to the default rather than being
       * stored — a status nothing can render is worse than the wrong tab.
       */
      status: isStockStatus(a.status) ? a.status : 'in_prep',
      // A due-in car has no arrival date yet. Anything else defaults to the day it was bought, which
      // is what every car recorded before this column existed effectively had.
      arrived_at: a.arrivedAt ?? (isStockStatus(a.status) && a.status === 'due_in' ? null : a.acquiredAt),
    },
    select: { id: true },
  });

  /**
   * THE MILEAGE IS A READING, NOT A COLUMN. It goes into the same series the MOT history and every
   * visit go into, under its own source, so the mileage trend on this car counts the day we bought it
   * like any other day. Storing it on the stock item instead would have given a number no chart could
   * see and a second place to ask a car how far it has gone.
   *
   * AFTER the stock row, deliberately. A reading is a fact about the car that stands whether or not
   * this purchase completes, so it must not be able to prevent the purchase being recorded; and
   * recordOdometerReadings upserts on (vehicle, source, date), so a retried intake writes one row.
   */
  const miles = parseMiles(a.mileageMiles);
  if ('miles' in miles && miles.miles !== null) {
    await recordOdometerReadings(prisma, {
      groupId: a.groupId, vehicleId: a.vehicleId, source: 'auction',
      readings: [{ date: a.acquiredAt, miles: miles.miles }],
    });
  }
  return { id: row.id, creditableInvoiceId };
}

/**
 * CLOSE A STOCK ITEM, and freeze what it cost.
 *
 * A DISPOSAL CLOSES IT, NOT AN INVOICE. A car can leave without one — traded out, scrapped, returned,
 * taken into own use — and an invoice may be raised before handover, so the invoice references this
 * row rather than causing it.
 *
 * FREEZE-AT-SALE happens in the same transaction. Prep costs are live while the car is in stock and
 * snapshotted here, for the reason invoice lines freeze at mint: a card edited in March must not move
 * a book that was read in February. The book is a QUERY, and these frozen rows are what make
 * re-running last year's quarter give what it gave then.
 */
export async function recordDisposal(a: {
  groupId: string; userId: string; stockItemId: string; disposedAt: Date;
  kind: unknown; salePence?: unknown; note?: unknown;
  /** What prep cost, as the caller can see it TODAY. Frozen here and never recomputed. */
  costs?: { kind: string; description: string; amountPence: unknown; jobCardId?: string | null }[];
}): Promise<{ id: string } | { refused: string }> {
  const kind = (DISPOSAL_KINDS as readonly string[]).includes(String(a.kind))
    ? (a.kind as DisposalKind) : null;
  if (!kind) return { refused: 'Say how the car left.' };

  const item = await prisma.stockItem.findFirst({
    where: { id: a.stockItemId, group_id: a.groupId },
    select: { id: true, acquired_at: true, disposal: { select: { id: true } } },
  });
  if (!item) return { refused: 'That stock record is not on this account.' };
  if (item.disposal) return { refused: 'That car has already left stock.' };
  if (a.disposedAt < item.acquired_at) {
    return { refused: 'A car cannot leave before it arrived.' };
  }

  // A SALE PRICE ONLY WHERE THERE WAS A SALE. Scrapped, returned and own use carry an honest null —
  // a scrapped car did not sell for nothing, it did not sell.
  const salePence = hasSalePrice(kind) ? asMoney(a.salePence) : null;

  const created = await prisma.$transaction(async (tx) => {
    const d = await tx.stockDisposal.create({
      data: {
        group_id: a.groupId, stock_item_id: a.stockItemId, created_by_user_id: a.userId,
        disposed_at: a.disposedAt, kind, sale_pence: salePence,
        note: typeof a.note === 'string' && a.note.trim() ? a.note.trim().slice(0, 500) : null,
      },
      select: { id: true },
    });
    const costs = (a.costs ?? [])
      .map((c) => ({
        group_id: a.groupId, stock_item_id: a.stockItemId,
        kind: String(c.kind).slice(0, 40),
        description: String(c.description).slice(0, 200),
        amount_pence: asMoney(c.amountPence),
        job_card_id: c.jobCardId ?? null,
      }))
      .filter((c) => c.amount_pence > 0 && c.description.length > 0);
    if (costs.length) await tx.stockCostSnapshot.createMany({ data: costs });

    /**
     * ── AND FREEZE WHAT THE PREP CARDS CONSUMED, PER CARD ────────────────────────────────────────
     *
     * Prep costs are LIVE while the car is in stock — a card edited today changes what the car has
     * cost today — and frozen here, in the same transaction as the disposal, for the reason invoice
     * lines freeze at mint: re-running last year's quarter must give what it gave then.
     *
     * ONE SNAPSHOT PER CARD, not one total. A book entry saying "£1,240 of parts" cannot be checked
     * against anything; one saying "£380, card 1043" can be walked back to the work. And a caller may
     * ALSO pass costs by hand (a delivery invoice, an MOT) — those are kept, so this adds rather than
     * replaces. Cards already snapshotted are skipped, so a re-disposal cannot double a car's costs.
     */
    const alreadyFrozen = new Set(
      (await tx.stockCostSnapshot.findMany({
        where: { stock_item_id: a.stockItemId, job_card_id: { not: null } },
        select: { job_card_id: true },
      })).map((r) => r.job_card_id as string),
    );
    const prepCards = await tx.jobCard.findMany({
      where: { group_id: a.groupId, stock_item_id: a.stockItemId },
      select: { id: true, items: { select: { item_type: true, qty: true, unit_cost: true } } },
    });
    const prepRows = prepCards
      .filter((c) => !alreadyFrozen.has(c.id))
      .map((c) => ({ id: c.id, cost: prepCost(c.items as never) }))
      .filter((c) => c.cost.partsPence > 0)
      .map((c) => ({
        group_id: a.groupId, stock_item_id: a.stockItemId, kind: 'parts',
        // The unknowns travel WITH the figure. A frozen £380 that silently omitted a £400 turbo is
        // indistinguishable later from a car that only used £380 of parts.
        description: c.cost.unknownCostLines
          ? `Prep parts (${c.cost.unknownCostLines} line(s) with no trade cost, not included)`
          : 'Prep parts',
        amount_pence: c.cost.partsPence,
        job_card_id: c.id,
      }));
    if (prepRows.length) await tx.stockCostSnapshot.createMany({ data: prepRows });

    /**
     * ── AND THE NON-PARTS COSTS, NETTED, FROZEN BESIDE THEM ──────────────────────────────
     *
     * Delivery in, valeting, MOT — and the credits that reversed any of them. Frozen here for the
     * same reason the prep cards are: the book is a query, and re-running last year's quarter must
     * give what it gave then.
     *
     * ONE ROW PER COST, and credits FOLD INTO the cost they reverse rather than arriving as separate
     * negative snapshots. StockCostSnapshot.amount_pence has no negative convention and a reader
     * summing it would otherwise have to know about reversal — so the netting happens HERE, once.
     * A cost credited in full freezes as nothing at all rather than a zero row, because a £0 line
     * invites "why is this here".
     */
    const liveRows = await tx.stockCost.findMany({
      where: { group_id: a.groupId, stock_item_id: a.stockItemId },
      select: { id: true, kind: true, description: true, amount_pence: true, reverses_id: true },
    });
    const creditedBy = new Map();
    for (const r of liveRows) {
      if (!r.reverses_id) continue;
      creditedBy.set(r.reverses_id, (creditedBy.get(r.reverses_id) ?? 0) + r.amount_pence);
    }
    const costRows = liveRows
      .filter((r) => !r.reverses_id)
      .map((r) => {
        const back = creditedBy.get(r.id) ?? 0;
        return {
          group_id: a.groupId, stock_item_id: a.stockItemId, kind: r.kind,
          description: back > 0
            ? `${r.description} (net of £${(back / 100).toFixed(2)} credited back)`
            : r.description,
          amount_pence: r.amount_pence - back,
          job_card_id: null,
        };
      })
      .filter((r) => r.amount_pence > 0);
    if (costRows.length) await tx.stockCostSnapshot.createMany({ data: costRows });
    return d;
  });
  return { id: created.id };
}

/**
 * THE EARLIER SALE OF THIS CAR, if there is one — for the surface to SHOW, never to act on.
 *
 * Most recent disposal-with-a-sale on any stock record for this vehicle. It carries the original cost
 * base because that is what a RETURN restores; a buyback reads the same row and uses none of it.
 */
export async function findPriorSale(groupId: string, vehicleId: string): Promise<PriorSale | null> {
  const d = await prisma.stockDisposal.findFirst({
    where: { group_id: groupId, kind: 'sold', stock_item: { vehicle_id: vehicleId } },
    orderBy: { disposed_at: 'desc' },
    select: {
      id: true, disposed_at: true, sale_pence: true,
      stock_item: { select: { purchase_pence: true, vat_status: true } },
    },
  });
  return d ? withInvoice(groupId, d) : null;
}

/** The same shape, addressed by the disposal the person actually pointed at. */
async function priorSaleByDisposal(groupId: string, disposalId: string): Promise<PriorSale | null> {
  const d = await prisma.stockDisposal.findFirst({
    where: { id: disposalId, group_id: groupId },
    select: {
      id: true, disposed_at: true, sale_pence: true,
      stock_item: { select: { purchase_pence: true, vat_status: true } },
    },
  });
  return d ? withInvoice(groupId, d) : null;
}

type DisposalRow = {
  id: string; disposed_at: Date; sale_pence: number | null;
  stock_item: { purchase_pence: number; vat_status: string };
};

/** ONE shape for both lookups, so the two cannot describe the same sale differently. */
async function withInvoice(groupId: string, d: DisposalRow): Promise<PriorSale> {
  const inv = await prisma.invoice.findFirst({
    where: { group_id: groupId, stock_disposal_id: d.id },
    select: { id: true, invoice_number: true },
  });
  return {
    disposalId: d.id,
    invoiceId: inv?.id ?? null,
    invoiceNumber: inv?.invoice_number ?? null,
    soldAt: d.disposed_at,
    salePence: d.sale_pence,
    originalPurchasePence: d.stock_item.purchase_pence,
    originalVatStatus: d.stock_item.vat_status,
  };
}

export type StockListRow = {
  stockItemId: string;
  vehicleId: string;
  registration: string;
  description: string | null;
  acquiredAt: Date;
  /** NULL = not yet arrived. The car is owned and is somewhere else. */
  arrivedAt: Date | null;
  status: string;
  /** NULL when the car has not arrived — never 0, which would claim it got here today. */
  daysInStock: number | null;
  purchasePence: number;
  vatStatus: string;
  source: string;
  /** LIVE prep spend: parts at TRADE COST from linked internal cards. Frozen at disposal, not before. */
  prepPence: number;
  /** NULL when no sale price has been estimated — not £0, which would read as a loss on every car. */
  projectedSalePence: number | null;
  projectedProfitPence: number | null;
  /** Lines with no trade cost recorded — counted, never valued at zero. */
  prepUnknownLines: number;
  prepCards: number;
  /** Set once the car has GONE. Null = still owned. The kind is shown on the row, not collapsed. */
  disposalKind: string | null;
  disposedAt: Date | null;
  salePence: number | null;
};

/**
 * EVERY CAR CURRENTLY IN STOCK — the default view, not a detail page reached from a vehicle.
 *
 * A garage doing a hundred a year opens this to see the yard, so it is a list first and a record
 * second. Ordered OLDEST FIRST: the car that has been there longest is the one costing money, and
 * putting it at the bottom of a list of forty would be filing the answer where nobody looks.
 */
export async function stockList(
  groupId: string, asOf: Date, opts: { vatRegistered?: boolean } = {},
): Promise<StockListRow[]> {
  const rows = await prisma.stockItem.findMany({
    where: { group_id: groupId, disposal: { is: null } },
    select: {
      id: true, vehicle_id: true, acquired_at: true, purchase_pence: true, vat_status: true, source: true,
      premium_pence: true, services_pence: true, projected_sale_pence: true,
      arrived_at: true, status: true,
      vehicle: { select: { registration: true, make: true, model: true } },
      disposal: { select: { disposed_at: true, kind: true, sale_pence: true } },
    },
    orderBy: { acquired_at: 'asc' },
  });

  /**
   * THE PREP CARDS, IN ONE QUERY, JOINED HERE.
   *
   * JobCard.stock_item_id carries NO foreign key — deliberately, so the migration stayed additive on
   * a shared database — which means Prisma has no relation to include and this is a second query
   * rather than a nested select. One query for the whole yard, not one per car: the join happens in
   * memory over a two-figure list.
   */
  const prepByItem = new Map<string, { partsPence: number; unknownCostLines: number; cards: number }>();
  if (rows.length) {
    const cards = await prisma.jobCard.findMany({
      where: { group_id: groupId, stock_item_id: { in: rows.map((r) => r.id) } },
      select: { stock_item_id: true, items: { select: { item_type: true, qty: true, unit_cost: true } } },
    });
    for (const c of cards) {
      const key = c.stock_item_id as string;
      const one = prepCost(c.items as never);
      const acc = prepByItem.get(key) ?? { partsPence: 0, unknownCostLines: 0, cards: 0 };
      prepByItem.set(key, {
        partsPence: acc.partsPence + one.partsPence,
        unknownCostLines: acc.unknownCostLines + one.unknownCostLines,
        cards: acc.cards + 1,
      });
    }
  }

  return rows.map((r) => ({
    stockItemId: r.id,
    vehicleId: r.vehicle_id,
    registration: r.vehicle?.registration ?? '—',
    description: [r.vehicle?.make, r.vehicle?.model].filter(Boolean).join(' ') || null,
    acquiredAt: r.acquired_at,
    arrivedAt: r.arrived_at,
    status: r.status,
    // FROM ARRIVAL, not purchase — and NULL for a car that has not turned up. See lib/stock::stockClock.
    daysInStock: daysOnForecourt({ acquiredAt: r.acquired_at, arrivedAt: r.arrived_at, status: r.status }, asOf),
    purchasePence: r.purchase_pence,
    vatStatus: r.vat_status,
    source: r.source,
    prepPence: prepByItem.get(r.id)?.partsPence ?? 0,
    prepUnknownLines: prepByItem.get(r.id)?.unknownCostLines ?? 0,
    prepCards: prepByItem.get(r.id)?.cards ?? 0,
    projectedSalePence: r.projected_sale_pence,
    disposalKind: r.disposal?.kind ?? null,
    disposedAt: r.disposal?.disposed_at ?? null,
    salePence: r.disposal?.sale_pence ?? null,
    // THE SAME MAPPER the detail page uses. A second arithmetic for the column would be a second
    // answer, and the one on the list is the one a person compares cars with.
    projectedProfitPence: projectStock({
      purchasePence: r.purchase_pence, premiumPence: r.premium_pence, servicesPence: r.services_pence,
      vatStatus: r.vat_status, source: r.source,
      // THE STOCKING COST counts forecourt time, so it uses the same clock — and 0 for a car that has
      // not arrived, because it is not yet costing space. The projection cannot take a null.
      daysInStock: daysOnForecourt({ acquiredAt: r.acquired_at, arrivedAt: r.arrived_at, status: r.status }, asOf) ?? 0,
      partsPence: prepByItem.get(r.id)?.partsPence ?? 0, projectedSalePence: r.projected_sale_pence,
    }, { vatRegistered: opts.vatRegistered === true })?.grossProfitPence ?? null,
  }));
}

/**
 * FIND OR CREATE THE CAR, BY REGISTRATION. A garage buying at auction has a registration and nothing
 * else; requiring the car to exist first would mean creating it somewhere else and coming back.
 *
 * NORMALISED FOR THE MATCH, stored as typed. "YP61 LBF" and "yp61lbf" are the same car, and the
 * garage should not have to know which spelling the database met first.
 */
export async function findOrCreateVehicle(a: {
  groupId: string; registration: string; make?: string | null; model?: string | null;
  /** Auction-invoice facts about the CAR. Each optional; each refuses rather than guessing. */
  vin?: unknown; firstRegistered?: Date | null; motExpiry?: Date | null;
  isImport?: unknown; v5cReference?: unknown; acquiredAt?: Date | null; now?: Date;
}): Promise<{ id: string } | { refused: string }> {
  const reg = a.registration.trim().toUpperCase();
  if (reg.length < 2) return { refused: 'Type the registration.' };
  const normalised = reg.replace(/[^A-Z0-9]/g, '');
  const found = await resolveVehicleByReg(a.groupId, reg, normalised);
  if (found) return applyIntakeAttributes(found, a);

  /**
   * A NEW CAR STILL HAS TO PASS THE SAME CHECKS. Validating only the update path would mean the very
   * first record of a car — the one with nothing to compare against and therefore the one whose
   * mistakes last longest — is the one nothing checks. So the attributes are decided against an empty
   * vehicle BEFORE the row exists: a refusal must not leave a half-made car behind.
   */
  const attrs = decideIntakeAttributes(
    { id: null, registration: reg, vin_normalized: null, mot_expiry: null, mot_checked_at: null }, a,
  );
  if ('refused' in attrs) return attrs;
  const collision = await vinCollision(a.groupId, (attrs.data.vin_normalized as string | undefined) ?? null, null);
  if (collision) return collision;

  const made = await prisma.vehicle.create({
    data: {
      group_id: a.groupId, registration: reg, registration_normalized: normalised,
      make: a.make?.trim() || null, model: a.model?.trim() || null,
      ...attrs.data,
    },
    select: { id: true },
  });
  return made;
}

/**
 * ── IS THIS CAR ALREADY ON FILE? ONE MATCHER, TWO CALLERS ───────────────────────────────────────
 *
 * find-or-create uses it before creating; the prior-sale lookup uses it and creates nothing. Written
 * once because two reg resolvers WILL diverge, and the way they diverge is that one of them finds the
 * legacy rows and the other quietly does not.
 *
 * THE FALLBACK IS NOT OPTIONAL. 35 of 1,836 vehicles on this database have registration_normalized
 * NULL — legacy rows written before that column was populated on every path. Matching only on it
 * found nothing for those cars, which in find-or-create meant creating a SECOND vehicle for one that
 * already existed. Found by a gate clause, not by reading the code.
 *
 * So the last resort normalises the STORED registration in the query rather than trusting a stored
 * normalisation. Unindexed, which is why it runs only after the indexed match misses.
 */
async function resolveVehicleByReg(
  groupId: string, reg: string, normalised: string,
): Promise<(VehicleIntakeRow & { id: string }) | null> {
  const found = await prisma.vehicle.findFirst({
    where: { group_id: groupId, OR: [{ registration: reg }, { registration_normalized: normalised }] },
    select: VEHICLE_INTAKE_FIELDS,
  });
  if (found) return found;

  const legacy = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Vehicle"
     WHERE "group_id" = ${groupId}
       AND regexp_replace(upper("registration"), '[^A-Z0-9]', '', 'g') = ${normalised}
     LIMIT 1`;
  if (!legacy.length) return null;
  return prisma.vehicle.findUnique({ where: { id: legacy[0].id }, select: VEHICLE_INTAKE_FIELDS });
}

/** FINDS ONLY. Creates nothing — the prior-sale lookup must not mint a car as a side effect of asking. */
export async function findVehicleByReg(groupId: string, registration: string): Promise<{ id: string } | null> {
  const reg = (registration || '').trim().toUpperCase();
  if (reg.length < 2) return null;
  return resolveVehicleByReg(groupId, reg, reg.replace(/[^A-Z0-9]/g, ''));
}

/** What intake needs to know about a car that is already on file, and nothing more. */
const VEHICLE_INTAKE_FIELDS = {
  id: true, registration: true, vin_normalized: true, mot_expiry: true, mot_checked_at: true,
} as const;

type VehicleIntakeRow = {
  id: string | null; registration: string; vin_normalized: string | null;
  mot_expiry: Date | null; mot_checked_at: Date | null;
};

type IntakeArgs = Parameters<typeof findOrCreateVehicle>[0];

/**
 * ── THE VIN IS AN IDENTITY, NOT A FIELD ─────────────────────────────────────────────────────────
 *
 * VehicleIdentity carries UNIQUE(group_id, vin_normalized), so a VIN is the tenant's canonical answer
 * to "which car is this". Two ways that goes wrong, and both FAIL CLOSED — the same rule
 * `sameRegistration` already applies to MOT writes, for the same reason: every one of these is a
 * request to write one car's facts onto another, and "we do not know which car this is" has exactly
 * one safe answer.
 *
 *   - the VIN is already on a DIFFERENT car in this tenant. Silently attaching would give two cars one
 *     identity and make the wrong one invisible rather than merely mislabelled;
 *   - this car already has a DIFFERENT VIN. Overwriting would rewrite the identity of a car that has
 *     history, quietly, from a form about a purchase.
 *
 * Both refusals NAME the other car. "VIN already in use" sends someone hunting through a list; "that
 * VIN is on YE64 KLM" ends the question.
 */
async function vinCollision(
  groupId: string, vin: string | null, selfId: string | null,
): Promise<{ refused: string } | null> {
  if (!vin) return null;
  const clash = await prisma.vehicle.findFirst({
    where: { group_id: groupId, vin_normalized: vin, ...(selfId ? { id: { not: selfId } } : {}) },
    select: { registration: true },
  });
  if (!clash) return null;
  return {
    refused: `That VIN is already on ${clash.registration} in this account. `
      + 'Two cars cannot share a VIN — check the logbook, or correct the other record first.',
  };
}

/** The pure half: every refusal decided against the car as it stands, before anything is written. */
function decideIntakeAttributes(
  v: VehicleIntakeRow, a: IntakeArgs,
): { data: Record<string, unknown> } | { refused: string } {
  const data: Record<string, unknown> = {};

  const vin = vinAtIntake(a.vin);
  if ('refused' in vin) return vin;
  if (vin.vin) {
    if (v.vin_normalized && v.vin_normalized !== vin.vin) {
      return {
        refused: `${v.registration} is already recorded with a different VIN. A purchase form does not `
          + 'get to change which car this is — fix it on the vehicle record if the stored one is wrong.',
      };
    }
    data.vin = vin.vin;
    data.vin_normalized = vin.vin;
  }

  if (a.firstRegistered && a.acquiredAt) {
    const bad = firstRegisteredRefusal(a.firstRegistered, a.acquiredAt, a.now ?? new Date());
    if (bad) return { refused: bad };
  }
  if (a.firstRegistered) data.first_registered = a.firstRegistered;

  /**
   * MOT: the owner's rule, enforced by a pure function so it is testable without DVSA. A typed date
   * may fill a silence and may never overwrite a checked one — and because mot_checked_at is stamped
   * ONLY by a real DVSA answer, writing the date and leaving the stamp alone IS the provenance. No
   * new column, and no way for this path to make a car look verified.
   */
  const mot = motExpiryDecision({ motExpiry: v.mot_expiry, motCheckedAt: v.mot_checked_at }, a.motExpiry ?? null);
  if ('refused' in mot) return mot;
  if (mot.write) data.mot_expiry = mot.write;

  // ABSENT NEVER ERASES. A form submitted without a field is silent about it, not a statement that the
  // stored value was wrong — the three-state parse turns "unknown" into null, and null must not write.
  const imported = parseImportStatus(a.isImport);
  if (imported !== null) data.is_import = imported;
  const v5c = normaliseV5c(a.v5cReference);
  if (v5c) data.v5c_reference = v5c;

  return { data };
}

/** The writing half: decide, check the VIN against the rest of the tenant, then update if anything moved. */
async function applyIntakeAttributes(
  v: VehicleIntakeRow & { id: string }, a: IntakeArgs,
): Promise<{ id: string } | { refused: string }> {
  const attrs = decideIntakeAttributes(v, a);
  if ('refused' in attrs) return attrs;
  const collision = await vinCollision(a.groupId, (attrs.data.vin_normalized as string | undefined) ?? null, v.id);
  if (collision) return collision;
  if (Object.keys(attrs.data).length) {
    await prisma.vehicle.update({ where: { id: v.id }, data: attrs.data });
  }
  return { id: v.id };
}

export type BookEntry = {
  stockItemId: string;
  registration: string | null;
  description: string | null;
  acquiredAt: Date;
  purchasePence: number;
  vatStatus: string;
  disposedAt: Date | null;
  kind: DisposalKind | null;
  salePence: number | null;
  /** Frozen prep costs. BESIDE the margin, never inside it. */
  costsPence: number;
} & BookRow;

/**
 * THE STOCK BOOK FOR A PERIOD, in two sections, covering EVERYTHING.
 *
 * Every car with its purchase details, and its sale details where sold. A car still held appears with
 * the sale side EMPTY — an honest null, not absent from the book. A car acquired in January and sold
 * in April appears in Q1 as in stock and in Q2 as a disposal: same car, two periods, counted as a
 * disposal exactly once.
 *
 * IT IS A QUERY, NOT A FILED ARTEFACT. What makes it reproducible is that the figures were frozen at
 * disposal — so this run and next year's run of the same quarter agree.
 */
export async function stockBook(groupId: string, periodStart: Date, periodEnd: Date): Promise<{
  inStock: BookEntry[]; disposals: BookEntry[];
}> {
  const items = await prisma.stockItem.findMany({
    where: { group_id: groupId, acquired_at: { lte: periodEnd } },
    select: {
      id: true, acquired_at: true, purchase_pence: true, vat_status: true,
      vehicle: { select: { registration: true, make: true, model: true } },
      disposal: { select: { disposed_at: true, kind: true, sale_pence: true } },
      costs: { select: { amount_pence: true } },
    },
    orderBy: { acquired_at: 'asc' },
  });

  const inStock: BookEntry[] = [];
  const disposals: BookEntry[] = [];
  for (const it of items) {
    const section = sectionFor({
      acquiredAt: it.acquired_at,
      disposedAt: it.disposal?.disposed_at ?? null,
      periodStart, periodEnd,
    });
    if (section === 'not_yet' || section === 'gone_before') continue;

    // THE ROW IS COMPUTED FROM THE PURCHASE AND THE SALE ONLY. Costs are summed separately and handed
    // back beside it; bookRow cannot see them, which is what stops prep ever reducing the margin.
    const disposed = section === 'disposed' && it.disposal
      ? { kind: it.disposal.kind as DisposalKind, salePence: it.disposal.sale_pence }
      : null;
    const row = bookRow({ purchasePence: it.purchase_pence, disposal: disposed });
    const entry: BookEntry = {
      stockItemId: it.id,
      registration: it.vehicle?.registration ?? null,
      description: [it.vehicle?.make, it.vehicle?.model].filter(Boolean).join(' ') || null,
      acquiredAt: it.acquired_at,
      purchasePence: it.purchase_pence,
      vatStatus: it.vat_status,
      disposedAt: disposed ? it.disposal!.disposed_at : null,
      kind: disposed ? disposed.kind : null,
      salePence: disposed ? disposed.salePence : null,
      costsPence: it.costs.reduce((a, c) => a + c.amount_pence, 0),
      ...row,
    };
    (section === 'disposed' ? disposals : inStock).push(entry);
  }
  return { inStock, disposals };
}

/** What HMRC is owed across a period's disposals. Floored per car — losses never offset. */
export function bookVatTotal(disposals: BookEntry[]): { duePence: number; unsettled: number } {
  return {
    duePence: disposals.reduce((a, d) => a + (d.vatDuePence ?? 0), 0),
    unsettled: disposals.filter((d) => d.vatPosition === 'unsettled').length,
  };
}

export { vatPositionFor };


/**
 * WHAT THIS CAR HAS COST IN PREP, RIGHT NOW — the live figure, read from the cards themselves.
 *
 * LIVE, not stored: while a car is in stock the answer changes whenever a prep card does, and a
 * stored total would be a second copy going stale between edits. It is frozen exactly once, at
 * disposal, by recordDisposal — after which the book reads the snapshots and never this.
 *
 * Returns the unknown-cost count alongside the money, because a cost base is only trustworthy if it
 * can say what it does not know. See lib/stock-prep for why labour is not in the figure.
 */
export async function liveStockCosts(
  groupId: string, stockItemId: string,
): Promise<PrepCost & { cards: number }> {
  const cards = await prisma.jobCard.findMany({
    where: { group_id: groupId, stock_item_id: stockItemId },
    select: { id: true, items: { select: { item_type: true, qty: true, unit_cost: true } } },
  });
  const totals = cards.reduce<PrepCost>((acc, c) => {
    const one = prepCost(c.items as never);
    return {
      partsPence: acc.partsPence + one.partsPence,
      unknownCostLines: acc.unknownCostLines + one.unknownCostLines,
      labourLines: acc.labourLines + one.labourLines,
    };
  }, { partsPence: 0, unknownCostLines: 0, labourLines: 0 });
  return { ...totals, cards: cards.length };
}


export type StockDetail = {
  stockItemId: string;
  vehicleId: string;
  registration: string;
  description: string | null;
  acquiredAt: Date;
  arrivedAt: Date | null;
  status: string;
  daysInStock: number | null;
  purchasePence: number;
  premiumPence: number;
  servicesPence: number;
  vatStatus: string;
  source: string;
  mileageWarranted: boolean | null;
  projectedSalePence: number | null;
  prep: PrepCost & { cards: number };
  /** The lines themselves — live while in stock, frozen card-level rows once gone. */
  prepDetail: PrepDetail | null;
  costRows: CostRow[];
  costs: CostTotals;
  projection: Projection | null;
  /** Disposed cars are READ-ONLY: their costs are frozen and the book must reproduce. */
  disposedAt: Date | null;
  disposalKind: string | null;
  salePence: number | null;
};

/** ONE car, everything the detail page shows, including the projection run on real figures. */
export async function stockDetail(
  groupId: string, stockItemId: string, asOf: Date, opts: { vatRegistered: boolean },
): Promise<StockDetail | null> {
  const it = await prisma.stockItem.findFirst({
    where: { id: stockItemId, group_id: groupId },
    select: {
      id: true, vehicle_id: true, acquired_at: true, purchase_pence: true, premium_pence: true,
      services_pence: true, vat_status: true, source: true, mileage_warranted: true,
      projected_sale_pence: true, arrived_at: true, status: true,
      vehicle: { select: { registration: true, make: true, model: true } },
      disposal: { select: { disposed_at: true, kind: true, sale_pence: true } },
    },
  });
  if (!it) return null;
  const prep = await liveStockCosts(groupId, it.id);
  const costRows = await stockCostRows(groupId, it.id);
  const prepDetail = await stockPrepDetail(groupId, it.id);
  const costs = netCosts(costRows, opts.vatRegistered);
  // SAME CLOCK as the list: arrival, not purchase, and null for a car that has not turned up.
  const days = daysOnForecourt(
    { acquiredAt: it.acquired_at, arrivedAt: it.arrived_at, status: it.status },
    it.disposal?.disposed_at ?? asOf,
  );
  return {
    stockItemId: it.id,
    vehicleId: it.vehicle_id,
    registration: it.vehicle?.registration ?? '—',
    description: [it.vehicle?.make, it.vehicle?.model].filter(Boolean).join(' ') || null,
    acquiredAt: it.acquired_at,
    arrivedAt: it.arrived_at,
    status: it.status,
    daysInStock: days,
    purchasePence: it.purchase_pence,
    premiumPence: it.premium_pence,
    servicesPence: it.services_pence,
    vatStatus: it.vat_status,
    source: it.source,
    mileageWarranted: it.mileage_warranted,
    projectedSalePence: it.projected_sale_pence,
    prep,
    prepDetail,
    costRows,
    costs,
    // A SOLD car has no projection: the real sale price is the answer, and showing what we used to
    // think beside what happened invites reading the guess as a result.
    projection: it.disposal ? null : projectStock({
      purchasePence: it.purchase_pence, premiumPence: it.premium_pence, servicesPence: it.services_pence,
      vatStatus: it.vat_status, source: it.source, daysInStock: days ?? 0,
      partsPence: prep.partsPence, projectedSalePence: it.projected_sale_pence,
      // NET of credits and NET of recoverable VAT — the cost actually borne, not the cash that moved.
      otherCostsPence: costs.costPence,
    }, opts),
    disposedAt: it.disposal?.disposed_at ?? null,
    disposalKind: it.disposal?.kind ?? null,
    salePence: it.disposal?.sale_pence ?? null,
  };
}

/**
 * ── WHAT MAY BE CORRECTED, AND WHAT MAY NOT ─────────────────────────────────────────────────────
 *
 * REFUSED HERE, not merely hidden on the page. A field absent from a form is a field a later form can
 * put back; a field the writer refuses stays refused.
 *
 *  - `vatStatus` is FROZEN. A car bought under the margin scheme stays a margin car whatever the
 *    tenant's own status does later, and recovering input VAT on a car forecloses the margin scheme
 *    for it — the choice is effectively made at purchase and may already be in a filed VAT return.
 *    Changing it is not a correction, it is a different car, and it needs its own deliberate path with
 *    the accountant's answer attached. See the accountant list.
 *  - `source` is FROZEN with it, because source decides which VAT statuses are even available
 *    (SOURCE_RULES): editing it could leave a stored vat_status the source does not permit.
 *  - A DISPOSED item is READ-ONLY entirely. Its costs froze at disposal so that re-running last
 *    year's quarter gives what it gave then; editing the purchase price afterwards would move a
 *    figure the book has already reported.
 *
 * EDITABLE: the acquisition date, the money actually paid, whether the mileage was warranted, and the
 * projected sale price. Those are things a person can simply have typed wrong.
 */
export async function updateStockItem(a: {
  groupId: string; stockItemId: string;
  acquiredAt?: Date | null; purchasePence?: unknown; premiumPence?: unknown; servicesPence?: unknown;
  mileageWarranted?: unknown; projectedSalePence?: unknown;
  /** Present ONLY so the refusal can name them. Never written. */
  vatStatus?: unknown; source?: unknown;
}): Promise<{ id: string } | { refused: string }> {
  const it = await prisma.stockItem.findFirst({
    where: { id: a.stockItemId, group_id: a.groupId },
    select: { id: true, vat_status: true, source: true, disposal: { select: { id: true } } },
  });
  if (!it) return { refused: 'That stock record is not on this account.' };

  if (it.disposal) {
    return {
      refused: 'This car has been sold and its figures were frozen at disposal. Re-running a past '
        + 'quarter has to give what it gave then, so nothing here can change now.',
    };
  }
  if (a.vatStatus !== undefined && a.vatStatus !== it.vat_status) {
    return {
      refused: 'The VAT treatment was captured when you bought the car and cannot be changed here. '
        + 'Reclaiming input VAT forecloses the margin scheme for this car and the choice may already '
        + 'be in a filed return — ask your accountant before changing it.',
    };
  }
  if (a.source !== undefined && a.source !== it.source) {
    return {
      refused: 'Where the car came from decides which VAT treatments it may have, so it is fixed '
        + 'alongside the VAT treatment.',
    };
  }

  const data: Record<string, unknown> = {};
  if (a.acquiredAt) data.acquired_at = a.acquiredAt;
  if (a.purchasePence !== undefined) data.purchase_pence = asMoney(a.purchasePence);
  if (a.premiumPence !== undefined) data.premium_pence = asMoney(a.premiumPence);
  if (a.servicesPence !== undefined) data.services_pence = asMoney(a.servicesPence);
  if (a.mileageWarranted !== undefined) data.mileage_warranted = parseWarranted(a.mileageWarranted);
  if (a.projectedSalePence !== undefined) {
    // BLANK CLEARS IT, back to "nobody has said" — which is a different thing from £0 and must stay
    // reachable, or a mistyped estimate can only ever be replaced by another estimate.
    const n = asMoney(a.projectedSalePence);
    data.projected_sale_pence = n > 0 ? n : null;
  }
  if (!Object.keys(data).length) return { id: it.id };
  await prisma.stockItem.update({ where: { id: it.id }, data });
  return { id: it.id };
}


/**
 * ── MOVE A CAR TO ANOTHER STATE, or record that it has turned up ────────────────────────────────
 *
 * The ONE writer for status and arrival. Both are statements a person makes, so both are refused
 * rather than guessed at, and neither is inferred from anything else changing.
 *
 * ARRIVING IS ITS OWN ACT. Moving a car off `due_in` without saying when it arrived would leave its
 * days-on-forecourt counting from the purchase date — the exact thing arrived_at exists to prevent —
 * so leaving due_in REQUIRES an arrival date, and the refusal says why.
 */
export async function setStockStatus(a: {
  groupId: string; stockItemId: string; status: unknown; arrivedAt?: Date | null;
}): Promise<{ id: string; status: StockStatus } | { refused: string }> {
  if (!isStockStatus(a.status)) return { refused: 'Say which state the car is in.' };
  const it = await prisma.stockItem.findFirst({
    where: { id: a.stockItemId, group_id: a.groupId },
    select: { id: true, status: true, arrived_at: true, acquired_at: true, disposal: { select: { id: true } } },
  });
  if (!it) return { refused: 'That stock record is not on this account.' };
  if (it.disposal) {
    return { refused: 'This car has gone. Its state was settled when you recorded how it left.' };
  }

  const leavingDueIn = it.status === 'due_in' && a.status !== 'due_in';
  const arrived = a.arrivedAt ?? it.arrived_at ?? (leavingDueIn ? null : it.acquired_at);
  if (a.status !== 'due_in' && !arrived) {
    return {
      refused: 'Say when it arrived. Days in stock counts from the day the car turned up, and without '
        + 'that date it would count from the day you bought it — which is what makes a week at the '
        + 'auction look like a week on your forecourt.',
    };
  }
  if (arrived && arrived < it.acquired_at) {
    return { refused: 'A car cannot arrive before you bought it.' };
  }

  const row = await prisma.stockItem.update({
    where: { id: it.id },
    // Going BACK to due_in clears the arrival date: the car is not here, and a stale date would keep
    // a clock running on a forecourt the car has left.
    data: { status: a.status, arrived_at: a.status === 'due_in' ? null : arrived },
    select: { id: true, status: true },
  });
  return { id: row.id, status: row.status as StockStatus };
}

/** The car's non-parts costs, as rows, oldest first. Live while in stock; frozen at disposal. */
export async function stockCostRows(groupId: string, stockItemId: string): Promise<CostRow[]> {
  const rows = await prisma.stockCost.findMany({
    where: { group_id: groupId, stock_item_id: stockItemId },
    orderBy: [{ incurred_on: 'asc' }, { created_at: 'asc' }],
    select: {
      id: true, kind: true, description: true, amount_pence: true, incurred_on: true,
      vat_treatment: true, reverses_id: true,
    },
  });
  return rows.map((r) => ({
    id: r.id, kind: r.kind, description: r.description, amountPence: r.amount_pence,
    incurredOn: r.incurred_on, vatTreatment: r.vat_treatment, reversesId: r.reverses_id,
  }));
}

/**
 * ADD A COST TO A CAR. Refused after disposal for the reason everything else is: the figures froze,
 * and a past quarter has to reproduce.
 */
export async function addStockCost(a: {
  groupId: string; userId: string; stockItemId: string;
  kind: unknown; description: unknown; amountPence: unknown; incurredOn: Date | null; vatTreatment: unknown;
}): Promise<{ id: string } | { refused: string }> {
  const it = await prisma.stockItem.findFirst({
    where: { id: a.stockItemId, group_id: a.groupId },
    select: { id: true, disposal: { select: { id: true } } },
  });
  if (!it) return { refused: 'That stock record is not on this account.' };
  if (it.disposal) {
    return {
      refused: 'This car has been sold and its costs froze at disposal, so nothing can be added to it '
        + 'now — re-running that quarter has to give what it gave then.',
    };
  }
  if (!isStockCostKind(a.kind)) return { refused: 'Say what kind of cost this is.' };
  if (!isVatTreatment(a.vatTreatment)) return { refused: 'Say how the supplier charged VAT on it.' };
  if (!a.incurredOn) return { refused: 'Say when you paid it. The date is what puts it in a quarter.' };
  const amount = asMoney(a.amountPence);
  if (!(amount > 0)) return { refused: 'Say how much it cost.' };
  const description = String(a.description ?? '').trim().slice(0, 200);
  if (!description) return { refused: 'Say what it was for — a figure with no description is unauditable.' };

  const row = await prisma.stockCost.create({
    data: {
      group_id: a.groupId, stock_item_id: a.stockItemId, created_by_user_id: a.userId,
      kind: a.kind, description, amount_pence: amount, incurred_on: a.incurredOn,
      vat_treatment: a.vatTreatment, reverses_id: null,
    },
    select: { id: true },
  });
  return { id: row.id };
}

/**
 * CREDIT A COST BACK OFF. Its own row naming what it reverses — never an edit, never a deletion.
 * Every rule that stops this massaging a cost base is in lib/stock-cost::checkCredit; this function
 * supplies the facts that rule needs and writes the row.
 */
export async function creditStockCost(a: {
  groupId: string; userId: string; stockItemId: string;
  reversesId: string; amountPence: unknown; incurredOn: Date | null; description?: unknown;
}): Promise<{ id: string } | { refused: string }> {
  const it = await prisma.stockItem.findFirst({
    where: { id: a.stockItemId, group_id: a.groupId },
    select: { id: true, disposal: { select: { id: true } } },
  });
  if (!it) return { refused: 'That stock record is not on this account.' };
  if (it.disposal) return { refused: CREDIT_AFTER_DISPOSAL_REFUSAL };
  if (!a.incurredOn) return { refused: 'Say when the credit came back.' };

  const rows = await stockCostRows(a.groupId, a.stockItemId);
  // SCOPED TO THIS CAR by construction: the target is looked up in this item's own rows, so a credit
  // cannot reach a cost on another car even if its id is supplied.
  const target = rows.find((r) => r.id === a.reversesId) ?? null;
  const already = rows.filter((r) => r.reversesId === a.reversesId).reduce((n, r) => n + r.amountPence, 0);
  const verdict = checkCredit(target, asMoney(a.amountPence), already);
  if ('refused' in verdict) return verdict;

  const row = await prisma.stockCost.create({
    data: {
      group_id: a.groupId, stock_item_id: a.stockItemId, created_by_user_id: a.userId,
      kind: (target as CostRow).kind,
      description: String(a.description ?? '').trim().slice(0, 200)
        || `Credit against ${(target as CostRow).description}`,
      amount_pence: asMoney(a.amountPence),
      incurred_on: a.incurredOn,
      // INHERITED, never chosen — otherwise a credit could reclaim VAT the cost never paid.
      vat_treatment: verdict.vatTreatment,
      reverses_id: a.reversesId,
    },
    select: { id: true },
  });
  return { id: row.id };
}

/** The netted totals for one car, through the same costPosition the purchase model uses. */
export async function stockCostTotals(
  groupId: string, stockItemId: string, vatRegistered: boolean,
): Promise<CostTotals> {
  return netCosts(await stockCostRows(groupId, stockItemId), vatRegistered);
}


/**
 * ── THE CARS THAT LEFT IN A PERIOD ──────────────────────────────────────────────────────────────
 *
 * Keyed on `disposed_at`, which never changes, over figures that FROZE at disposal — so re-running a
 * closed quarter gives what it gave then. The costs come from StockCostSnapshot, which already holds
 * prep parts per card and non-parts costs net of credits; nothing is recomputed live.
 *
 * Days in stock is the one live derivation and it is arrival-to-disposal, so it answers "how long did
 * this car sit on my forecourt" rather than "how long did I own it". A car with no arrival recorded
 * yields NULL and is counted separately rather than averaged in at its purchase date.
 */
export async function soldInPeriod(
  groupId: string, from: Date, to: Date,
): Promise<{ rows: SoldRow[]; summary: SoldSummary }> {
  const items = await prisma.stockItem.findMany({
    where: { group_id: groupId, disposal: { is: { disposed_at: { gte: from, lte: to } } } },
    select: {
      id: true, acquired_at: true, arrived_at: true, status: true, purchase_pence: true,
      vehicle: { select: { registration: true } },
      disposal: { select: { disposed_at: true, kind: true, sale_pence: true } },
      costs: { select: { amount_pence: true } },
    },
    orderBy: { acquired_at: 'asc' },
  });
  const rows: SoldRow[] = items.map((it) => ({
    stockItemId: it.id,
    registration: it.vehicle?.registration ?? '—',
    disposedAt: it.disposal!.disposed_at,
    kind: it.disposal!.kind,
    salePence: it.disposal!.sale_pence,
    purchasePence: it.purchase_pence,
    // FROZEN. The snapshots are the record; the live readers are for cars still in stock.
    costsPence: it.costs.reduce((a, c) => a + c.amount_pence, 0),
    daysInStock: daysOnForecourt(
      { acquiredAt: it.acquired_at, arrivedAt: it.arrived_at, status: it.status },
      it.disposal!.disposed_at,
    ),
  }));
  // Sorted by when they left — a period report reads chronologically, not by when they were bought.
  rows.sort((a, b) => a.disposedAt.getTime() - b.disposedAt.getTime());
  return { rows, summary: summariseSold(rows) };
}


/** One frozen row, as the book holds it. Card-level, because that is what disposal recorded. */
export type FrozenCostRow = {
  kind: string; description: string; amountPence: number; jobCardId: string | null;
};

export type PrepDetail =
  | { mode: 'live'; groups: PrepCardGroup[] }
  | { mode: 'frozen'; rows: FrozenCostRow[] };

/**
 * ── WHAT WENT INTO THIS CAR, IN DETAIL ──────────────────────────────────────────────────────────
 *
 * TWO MODES, and which one you get is decided by whether the car has gone — not by a flag the caller
 * passes, because a caller that could ask for live lines on a sold car would eventually do it.
 *
 *   live    the car is in stock: the actual lines, grouped by card. The figures move as work is done,
 *           which is correct — nothing is frozen yet.
 *   frozen  the car has gone: the snapshot rows, one per card. The lines still exist on the cards but
 *           the frozen record does not reference them, and reading them back could disagree with what
 *           the car was reported to have cost. See FROZEN_DETAIL_NOTE.
 */
export async function stockPrepDetail(groupId: string, stockItemId: string): Promise<PrepDetail | null> {
  const it = await prisma.stockItem.findFirst({
    where: { id: stockItemId, group_id: groupId },
    select: { id: true, disposal: { select: { id: true } } },
  });
  if (!it) return null;

  if (it.disposal) {
    const rows = await prisma.stockCostSnapshot.findMany({
      where: { group_id: groupId, stock_item_id: it.id },
      orderBy: { captured_at: 'asc' },
      select: { kind: true, description: true, amount_pence: true, job_card_id: true },
    });
    return {
      mode: 'frozen',
      rows: rows.map((r) => ({
        kind: r.kind, description: r.description, amountPence: r.amount_pence, jobCardId: r.job_card_id,
      })),
    };
  }

  const cards = await prisma.jobCard.findMany({
    where: { group_id: groupId, stock_item_id: it.id },
    orderBy: { created_at: 'asc' },
    select: {
      id: true, created_at: true,
      items: {
        orderBy: { created_at: 'asc' },
        select: { item_type: true, description: true, qty: true, unit_cost: true },
      },
    },
  });
  return { mode: 'live', groups: groupPrepLines(cards as never) };
}
