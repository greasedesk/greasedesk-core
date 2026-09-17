/**
 * File: lib/stock-after-sale.ts
 *
 * THE READER for comeback and warranty work on sold cars. The rules and the words are
 * lib/stock-after-sale-rules; this fetches the cards and hands them over.
 *
 * WHICH CARDS: on the sold car's vehicle, created on or after the sale day and before that car next came
 * into stock; a comeback, or invoiced on the warranty series; not cancelled or a no-show. The sale card
 * and prep cards need no filter of their own: a sale card is neither a comeback nor warranty, and a prep
 * card cannot fall in the window — the car is not in stock between its sale and its next holding. A filter
 * for them was written and removed: no fixture could reach it, so it proved nothing. WHICH LINES: the FROZEN invoice lines once the card is invoiced (the ledger
 * rule: an invoice reads what it froze), the card's live items until then.
 *
 * READ ONLY. Nothing here writes to a stock record, a snapshot or a disposal: the sale's frozen figures
 * are untouched by construction, and the gate re-reads them to prove it.
 */
import { prisma } from '@/lib/db';
import { afterSaleFigures, inAfterSaleWindow, type AfterSaleCardInput, type AfterSaleFigures } from '@/lib/stock-after-sale-rules';

const TERMINAL_NOT_WORK = ['cancelled', 'no_show'];

export async function afterSaleWork(groupId: string, stockItemIds: string[]): Promise<Map<string, AfterSaleFigures>> {
  const result = new Map<string, AfterSaleFigures>();
  if (!stockItemIds.length) return result;
  const sold = await prisma.stockItem.findMany({
    where: { group_id: groupId, id: { in: stockItemIds }, disposal: { isNot: null } },
    select: { id: true, vehicle_id: true, acquired_at: true, disposal: { select: { disposed_at: true } } },
  });
  if (!sold.length) return result;
  const vehicleIds = [...new Set(sold.map((s) => s.vehicle_id))];

  // THE NEXT TIME EACH CAR CAME BACK INTO STOCK — the end of the window for the sale before it.
  const allHoldings = await prisma.stockItem.findMany({
    where: { group_id: groupId, vehicle_id: { in: vehicleIds } },
    select: { vehicle_id: true, acquired_at: true },
  });

  const earliestSale = new Date(Math.min(...sold.map((s) => s.disposal!.disposed_at.getTime())) - 86_400_000);
  const cards = await prisma.jobCard.findMany({
    where: {
      group_id: groupId, vehicle_id: { in: vehicleIds },
      created_at: { gte: earliestSale },
      status: { notIn: TERMINAL_NOT_WORK as never },
      OR: [{ is_comeback: true }, { invoice: { is: { series: 'warranty' } } }],
    },
    select: {
      id: true, vehicle_id: true, created_at: true, is_comeback: true,
      items: { select: { item_type: true, qty: true, unit_cost: true, labour_hours: true } },
      invoice: { select: { invoice_number: true, lines: { select: { item_type: true, qty: true, unit_cost: true, labour_hours: true } } } },
    },
  });

  for (const s of sold) {
    const soldAt = s.disposal!.disposed_at;
    const next = allHoldings
      .filter((h) => h.vehicle_id === s.vehicle_id && h.acquired_at.getTime() > s.acquired_at.getTime())
      .map((h) => h.acquired_at)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const mine: AfterSaleCardInput[] = cards
      .filter((c) => c.vehicle_id === s.vehicle_id && inAfterSaleWindow(c.created_at, soldAt, next))
      .map((c) => ({
        cardId: c.id, createdAt: c.created_at, isComeback: c.is_comeback,
        invoiceNumber: c.invoice?.invoice_number ?? null,
        // FROZEN once invoiced. An invoice with NO lines still reads as the invoice: an empty freeze is a fact.
        lines: (c.invoice ? c.invoice.lines : c.items).map((l) => ({
          item_type: String(l.item_type ?? ''), qty: l.qty, unit_cost: l.unit_cost, labour_hours: l.labour_hours,
        })),
      }));
    result.set(s.id, afterSaleFigures(mine));
  }
  return result;
}
