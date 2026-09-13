/**
 * File: lib/stock-store.ts
 * THE ONE WRITER for stock, and the one reader of the book. Every scope is tenant-checked here rather
 * than by each caller — the same shape as lib/purchase-model-store.
 */
import { prisma } from '@/lib/db';
import {
  DISPOSAL_KINDS, bookRow, daysInStock, hasSalePrice, sectionFor, vatPositionFor,
  type BookRow, type DisposalKind,
} from '@/lib/stock';
import { SOURCES, VAT_STATUSES, type PurchaseSource, type VatStatus } from '@/lib/purchase-model';
import {
  firstRegisteredRefusal, motExpiryDecision, normaliseV5c, parseImportStatus, parseMiles,
  parseWarranted, vinAtIntake,
} from '@/lib/stock-intake';
import { recordOdometerReadings } from '@/lib/odometer';
import { prepCost, type PrepCost } from '@/lib/stock-prep';

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
}): Promise<{ id: string } | { refused: string }> {
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

  const row = await prisma.stockItem.create({
    data: {
      group_id: a.groupId, vehicle_id: a.vehicleId, created_by_user_id: a.userId,
      acquired_at: a.acquiredAt,
      purchase_pence: asMoney(a.purchasePence),
      // CAPTURED AT PURCHASE. Never re-read from the tenant's profile: a margin car stays a margin car.
      vat_status: vatStatus, source,
      premium_pence: asMoney(a.premiumPence), services_pence: asMoney(a.servicesPence),
      // A TERM OF THIS SALE, not a fact about the car — see the schema comment for why it lives here.
      mileage_warranted: parseWarranted(a.mileageWarranted),
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
  return { id: row.id };
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
    return d;
  });
  return { id: created.id };
}

export type StockListRow = {
  stockItemId: string;
  vehicleId: string;
  registration: string;
  description: string | null;
  acquiredAt: Date;
  daysInStock: number;
  purchasePence: number;
  vatStatus: string;
  source: string;
  /** LIVE prep spend: parts at TRADE COST from linked internal cards. Frozen at disposal, not before. */
  prepPence: number;
  /** Lines with no trade cost recorded — counted, never valued at zero. */
  prepUnknownLines: number;
  prepCards: number;
};

/**
 * EVERY CAR CURRENTLY IN STOCK — the default view, not a detail page reached from a vehicle.
 *
 * A garage doing a hundred a year opens this to see the yard, so it is a list first and a record
 * second. Ordered OLDEST FIRST: the car that has been there longest is the one costing money, and
 * putting it at the bottom of a list of forty would be filing the answer where nobody looks.
 */
export async function stockList(groupId: string, asOf: Date): Promise<StockListRow[]> {
  const rows = await prisma.stockItem.findMany({
    where: { group_id: groupId, disposal: { is: null } },
    select: {
      id: true, vehicle_id: true, acquired_at: true, purchase_pence: true, vat_status: true, source: true,
      vehicle: { select: { registration: true, make: true, model: true } },
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
    daysInStock: daysInStock(r.acquired_at, asOf),
    purchasePence: r.purchase_pence,
    vatStatus: r.vat_status,
    source: r.source,
    prepPence: prepByItem.get(r.id)?.partsPence ?? 0,
    prepUnknownLines: prepByItem.get(r.id)?.unknownCostLines ?? 0,
    prepCards: prepByItem.get(r.id)?.cards ?? 0,
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
  // THE INDEXED MATCH FIRST — it covers all but the legacy rows and costs one indexed lookup.
  const found = await prisma.vehicle.findFirst({
    where: { group_id: a.groupId, OR: [{ registration: reg }, { registration_normalized: normalised }] },
    select: VEHICLE_INTAKE_FIELDS,
  });
  if (found) return applyIntakeAttributes(found, a);

  /**
   * ── AND A FALLBACK THAT DOES NOT TRUST THE COLUMN ───────────────────────────────────────────
   * 35 of 1,836 vehicles on this database have registration_normalized NULL — legacy rows written
   * before that column was populated on every path. Matching only on it would have found nothing for
   * those cars, created a SECOND vehicle for one that already existed, and hung a stock record off
   * the wrong id. Found by a gate clause, not by reading the code.
   *
   * So the last resort normalises the STORED registration in the query instead of trusting a stored
   * normalisation. Slower and unindexed, which is why it runs only after the indexed match misses.
   */
  const legacy = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Vehicle"
     WHERE "group_id" = ${a.groupId}
       AND regexp_replace(upper("registration"), '[^A-Z0-9]', '', 'g') = ${normalised}
     LIMIT 1`;
  if (legacy.length) {
    const row = await prisma.vehicle.findUnique({
      where: { id: legacy[0].id }, select: VEHICLE_INTAKE_FIELDS,
    });
    if (row) return applyIntakeAttributes(row, a);
  }

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
