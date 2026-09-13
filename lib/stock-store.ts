/**
 * File: lib/stock-store.ts
 * THE ONE WRITER for stock, and the one reader of the book. Every scope is tenant-checked here rather
 * than by each caller — the same shape as lib/purchase-model-store.
 */
import { prisma } from '@/lib/db';
import {
  DISPOSAL_KINDS, bookRow, hasSalePrice, sectionFor, vatPositionFor,
  type BookRow, type DisposalKind,
} from '@/lib/stock';
import { SOURCES, VAT_STATUSES, type PurchaseSource, type VatStatus } from '@/lib/purchase-model';

const asMoney = (v: unknown, cap = 100000000): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(cap, Math.round(n)) : 0;
};

/** Bring a car into stock. The row IS the assertion of ownership; no ownership edge is written. */
export async function takeIntoStock(a: {
  groupId: string; userId: string; vehicleId: string; acquiredAt: Date;
  purchasePence: unknown; vatStatus: unknown; source: unknown;
  premiumPence?: unknown; servicesPence?: unknown;
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
    },
    select: { id: true },
  });
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
    return d;
  });
  return { id: created.id };
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
