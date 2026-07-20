/**
 * File: lib/import-emit.ts
 * THE one way a staged invoice becomes JobCardItem rows.
 *
 * Extracted so the first commit and a RE-COMMIT cannot diverge. The seven May invoices were wrong
 * because the commit path differed from the estimate path about VAT; a correction pass that grew its
 * own second copy of this logic would be the same mistake with a different pair of writers.
 *
 * Everything the 2026-07-20 fixes established lives here: per-line VAT from computeQuoteTotals (the
 * function the estimate path persists from), and printed amounts that survive a 2-dp column.
 */
import type { Prisma } from '@prisma/client';
import { computeQuoteTotals } from '@/lib/quote-totals';
import { upsertMemory } from '@/lib/import-memory';

export type EmitArgs = {
  groupId: string;
  cardId: string;
  /** Staged lines INCLUDING split children; parents are excluded by the caller's splitParents set. */
  lines: any[];
  splitParentIds: Set<string>;
  profile: { defaultRateBp: number; isRegistered: boolean };
};

/** Replace the card's items with the staged invoice's lines, through the fixed path. */
export async function emitCardItemsFromStaged(tx: Prisma.TransactionClient, args: EmitArgs): Promise<number> {
  const { groupId, cardId, profile } = args;
  const staged = { lines: args.lines };
  const splitParents = args.splitParentIds;
      const emit = staged.lines.filter((l: any) => !splitParents.has(l.id));

  /**
   * ONE VAT IMPLEMENTATION. Per-line VAT comes from computeQuoteTotals — the same function the
   * estimate path persists from (jobcard-quote writes vat_amount from totals.lines[i]) — so the
   * import and the estimate cannot disagree about the tax on a line. This path previously wrote
   * `vat_rate` and left `vat_amount` at its 0 default; invoice-issue freezes line_vat FROM
   * vat_amount, so six of the seven May invoices reached the ledger carrying 20% and £0.00.
   *
   * `vatable` maps the printed VAT column: a line reading "No VAT" (an MOT) is not vatable, and
   * everything else takes the tenant's rate.
   */
  const emitVatable = emit.map((l: any) => !/no vat/i.test(l.vat_text ?? ''));
  /**
   * THE PRINTED AMOUNT IS THE TRUTH, and it must survive a 2-dp column. InvoiceLine.unit_price is
   * Decimal(12,2) and invoice-issue DERIVES line_total = qty × unit_price, so a 4-dp price loses
   * the printed figure: 2 × 133.3333 = £266.67 printed, but 2 × 133.33 = £266.66 written, and a
   * split child at 2 × 58.335 wrote £116.68 against £116.67. Where the 2-dp derivation cannot
   * reproduce the printed amount, the line is emitted at QTY 1 with unit_price = the amount, so
   * qty × unit_price lands exactly and no reader ever sees line_total ≠ qty × unit_price.
   *
   * The loss is COSMETIC AND ONLY ON THE GRAIN: the "2 x" is already in the description the
   * invoice printed ("Supply and fit 2 x front wheel bearing"), the money is unchanged to the
   * penny, and every downstream reader (margin, VAT, charged hours via labour_hours) works from
   * amounts and item_type, not from qty.
   */
  const exactLine = (l: any) => {
    const amountPennies = Math.round(Number(l.amount) * 100);
    const qty = Number(l.qty);
    const derived = Math.round(qty * Math.round(Number(l.unit_price) * 100)) / 1; // qty × 2dp price, in pennies
    return derived === amountPennies
      ? { qty: l.qty as any, unit_price: l.unit_price as any }
      : { qty: 1 as any, unit_price: (amountPennies / 100) as any };
  };
  const shaped = emit.map((l: any, i: number) => ({ line: l, ...exactLine(l), vatable: emitVatable[i] }));

  const totals = computeQuoteTotals(
    // PENNIES — QuoteLineInput is an integer-penny contract (unit_price_pennies), which is why
    // the totals must be built from it rather than from pounds.
    shaped.map((x: any) => ({
      item_type: ((x.line.kind ?? 'part') as any),
      qty: Number(x.qty),
      unit_price_pennies: Math.round(Number(x.unit_price) * 100),
      unit_cost_pennies: null,
      vatable: x.vatable,
    })) as any,
    profile.defaultRateBp / 100,
    { vatRegistered: profile.isRegistered },
  );

  for (let i = 0; i < shaped.length; i++) {
    const { line: l, qty, unit_price, vatable } = shaped[i];
    let catalogueItemId = l.catalogue_item_id;
    // NEVER mint when the line is ALREADY resolved to an existing product. The picker sets
    // catalogue_item_id AND parts_cost together, so a `parts_cost != null` test alone would
    // mint an IMP- duplicate and overwrite the operator's choice.
    if (!l.is_adjustment && l.parts_cost != null && !catalogueItemId) {
      const timesSeen = await tx.stagedLine.count({
        where: { description: l.description, unit_price: l.unit_price, staged_invoice: { group_id: groupId } },
      });
      catalogueItemId = await upsertMemory(tx, {
        groupId: groupId,
        description: l.description,
        unitPrice: Number(l.unit_price),
        itemType: (l.kind ?? 'part') as any,
        unitCostPennies: Math.round(Number(l.parts_cost) * 100),
        labourHours: l.labour_hours == null ? null : Number(l.labour_hours),
        timesSeen,
        vatRate: vatable ? profile.defaultRateBp / 100 : 0,
      });
    }
    await tx.jobCardItem.create({
      data: {
        job_card_id: cardId,
        description: l.description,
        qty,
        unit_price,
        unit_cost: (l.is_adjustment ? 0 : l.parts_cost) as any, // null stays NULL = unknown
        labour_hours: (l.labour_hours ?? null) as any,
        item_type: (l.kind ?? 'part') as any,
        vat_rate: (vatable ? profile.defaultRateBp / 100 : 0) as any,
        // FROM THE SHARED CHOKEPOINT — never computed here a second time.
        vat_amount: (totals.lines[i].vat_pennies / 100) as any,
        catalogue_item_id: catalogueItemId,
        cost_basis: l.cost_basis,
      } as any,
    });
  }


  return emit.length;
}
