/**
 * File: lib/stock-cost.ts
 *
 * WHAT A CAR COST BESIDES ITS PARTS, and how a credit takes it back off.
 *
 * Pure. The vocabulary, the credit rules and the netting live here so the writer, the book and the
 * page cannot each decide separately what a car has cost.
 *
 * ── WHY ONLY THESE THREE ────────────────────────────────────────────────────────────────────────
 *
 * Delivery in, valeting and MOT are money out, attributable to one car, on a date. That is the whole
 * test, and two obvious candidates fail it:
 *
 *   ADVERTISING is an apportioned share, not a direct cost. lib/purchase-model already models the
 *   platform as SLOTS — a monthly fee divided by the cars occupying it — so a car's share changes when
 *   the number of cars changes. Writing a fixed figure onto a car would freeze an apportionment that
 *   is not frozen, and the two would drift with nothing to say which was right.
 *
 *   A WARRANTY PROVISION is a forecast. Putting an estimate of a future cost into the same table as
 *   money that has actually left makes the cost base a blend of fact and guess, and the book stops
 *   being a record. It belongs in the projection until a claim is PAID — at which point the payment
 *   is money out on a date, and enters here as an ordinary cost like any other. NOT BUILT.
 */
import { VAT_TREATMENTS, costPosition, type VatTreatment } from '@/lib/purchase-model';

export const STOCK_COST_KINDS = ['delivery_in', 'valeting', 'mot'] as const;
export type StockCostKind = (typeof STOCK_COST_KINDS)[number];

export const STOCK_COST_LABELS: Record<StockCostKind, string> = {
  delivery_in: 'Delivery in',
  valeting: 'Valeting',
  mot: 'MOT',
};

export const isStockCostKind = (k: unknown): k is StockCostKind =>
  (STOCK_COST_KINDS as readonly string[]).includes(String(k));
/**
 * WHAT A PAST SALE MAY CARRY. Today the same three; lib/stock-historical reads THIS, not the live list,
 * so a kind allowed only on a recorded sale has one place to be added.
 */
export const HISTORICAL_COST_KINDS: readonly string[] = [...STOCK_COST_KINDS];
export const isHistoricalCostKind = (k: unknown): boolean => HISTORICAL_COST_KINDS.includes(String(k));
export const isVatTreatment = (v: unknown): v is VatTreatment =>
  (VAT_TREATMENTS as readonly string[]).includes(String(v));

export type CostRow = {
  id: string;
  kind: string;
  description: string;
  amountPence: number;
  incurredOn: Date;
  vatTreatment: string;
  /** Set = this row is a CREDIT against that cost id. */
  reversesId: string | null;
};

/**
 * ── WHAT A CREDIT MAY BE, AND WHAT STOPS IT MASSAGING A COST BASE ───────────────────────────────
 *
 * A credit is its OWN ROW naming the cost it reverses. It is never an edit and never a deletion: the
 * original stays, because a supplier warrantying a failed turbo does not mean the car never had one.
 * The truth is £410 out and £410 back, and a cost base that simply forgot the £410 would be a car
 * carrying a part it did not pay for — wrong in the other direction.
 *
 * Four rules, and the third is the one that does the work:
 *
 *   1. it must NAME a cost — a free-floating negative is exactly the thing that massages a total;
 *   2. that cost must be on the SAME CAR;
 *   3. credits against one cost may not EXCEED it. You cannot credit £600 against a £410 turbo, so a
 *      credit can only ever undo a payment that was made and never invent one that was not;
 *   4. a credit may not credit a credit, which would make (3) a sum over a cycle.
 *
 * And the VAT treatment is INHERITED, never chosen: a credit reverses the same treatment the cost
 * carried, or you could reclaim input tax you never paid.
 */
export type CreditCheck = { ok: true; vatTreatment: string } | { refused: string };

export function checkCredit(
  target: CostRow | null,
  amountPence: number,
  alreadyCreditedPence: number,
): CreditCheck {
  if (!target) {
    return { refused: 'A credit has to say which cost it is reversing. Pick the cost it came back on.' };
  }
  if (target.reversesId) {
    return { refused: 'That is already a credit. Credit the original cost, not the credit.' };
  }
  if (!(amountPence > 0)) {
    return { refused: 'Say how much came back. A credit is entered as a positive amount — it is the row that carries the sign, not the number.' };
  }
  const remaining = target.amountPence - alreadyCreditedPence;
  if (amountPence > remaining) {
    return {
      refused: `You can only credit back what was paid. £${(target.amountPence / 100).toFixed(2)} went out on that cost`
        + (alreadyCreditedPence > 0 ? ` and £${(alreadyCreditedPence / 100).toFixed(2)} has already come back` : '')
        + `, so at most £${(remaining / 100).toFixed(2)} is left to credit.`,
    };
  }
  return { ok: true, vatTreatment: target.vatTreatment };
}

export type CostTotals = {
  /** Gross money out, net of credits. Never negative by construction — see checkCredit rule 3. */
  netPence: number;
  /** Input VAT recoverable on these costs, net of credits. */
  reclaimablePence: number;
  /** The cost actually borne — gross minus what can be reclaimed. This is what the car is charged. */
  costPence: number;
  grossOutPence: number;
  creditedPence: number;
  rows: number;
};

/**
 * NET, THROUGH THE SAME costPosition THE PURCHASE MODEL USES — per row, because recoverability is a
 * property of the supplier's invoice and not of the car.
 *
 * costPosition FLOORS ITS INPUT AT ZERO, so a credit cannot simply be passed through it as a negative.
 * Each credit is valued at its own positive amount under the treatment it inherited, and SUBTRACTED.
 * Passing −£410 in would have returned £0 and silently lost the credit.
 */
export function netCosts(rows: CostRow[], vatRegistered: boolean): CostTotals {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let grossOut = 0, credited = 0, reclaim = 0, cost = 0;
  for (const r of rows) {
    const treatment = (isVatTreatment(r.vatTreatment) ? r.vatTreatment : 'standard_not_recoverable') as VatTreatment;
    const pos = costPosition(r.amountPence, treatment, vatRegistered);
    if (r.reversesId) {
      // Inherited in the writer; re-read here so a row written before that rule still nets correctly.
      const src = byId.get(r.reversesId);
      const t = (src && isVatTreatment(src.vatTreatment) ? src.vatTreatment : treatment) as VatTreatment;
      const back = costPosition(r.amountPence, t, vatRegistered);
      credited += back.cashPence;
      reclaim -= back.reclaimablePence;
      cost -= back.costPence;
    } else {
      grossOut += pos.cashPence;
      reclaim += pos.reclaimablePence;
      cost += pos.costPence;
    }
  }
  return {
    netPence: grossOut - credited,
    reclaimablePence: reclaim,
    costPence: cost,
    grossOutPence: grossOut,
    creditedPence: credited,
    rows: rows.length,
  };
}

/**
 * ── WHAT FREEZES AT DISPOSAL: THE SAME FIGURE THE CAR SHOWED THE MOMENT BEFORE ─────────────────
 *
 * A CAR MUST NOT CHANGE COST BY BEING SOLD. While in stock the car's page charges it `costPence` from
 * netCosts — gross less the VAT the garage can reclaim. The freeze used to copy `amount_pence` minus
 * credits, which is GROSS: a VAT-registered garage's £54 recoverable MOT cost the car £45 on Monday and
 * £54 on the sold dashboard on Tuesday, with nothing but the sale in between.
 *
 * So each cost is frozen THROUGH netCosts, together with the credits against it, and nothing here does
 * its own VAT arithmetic. One row per cost; a cost credited in full freezes as nothing at all, because a
 * £0 line invites "why is this here". The treatment is not carried onto the snapshot — the snapshot
 * holds the ANSWER, which is the point of a freeze.
 *
 * `vatRegistered` is the tenant's status AT DISPOSAL, read by the writer, never a constant.
 */
export type FrozenCost = { costId: string; kind: string; description: string; amountPence: number };

export function frozenCostRows(rows: CostRow[], vatRegistered: boolean): FrozenCost[] {
  const out: FrozenCost[] = [];
  for (const r of rows) {
    if (r.reversesId) continue;
    const credits = rows.filter((c) => c.reversesId === r.id);
    const t = netCosts([r, ...credits], vatRegistered);
    if (t.costPence <= 0) continue;
    out.push({
      costId: r.id,
      kind: r.kind,
      description: t.creditedPence > 0
        ? `${r.description} (net of £${(t.creditedPence / 100).toFixed(2)} credited back)`
        : r.description,
      amountPence: t.costPence,
    });
  }
  return out;
}

/**
 * A CREDIT THAT ARRIVES AFTER THE CAR IS SOLD DOES NOT BELONG TO THE CAR.
 *
 * Its costs froze at disposal, and the quarter that reported them must go on reporting them: the car
 * DID cost £410 of turbo when it was sold, and that was true then. A credit received later is a
 * supplier credit in the period it was received — the same two-clocks reasoning lib/credit-note
 * applies to VAT. Refused here, and the refusal says where it goes instead rather than just no.
 */
export const CREDIT_AFTER_DISPOSAL_REFUSAL =
  'This car has been sold and its costs froze at disposal — re-running that quarter has to give what '
  + 'it gave then. A credit that arrives now is a supplier credit in the period you received it, not a '
  + 'change to what the car cost when you sold it. Put it through your purchase ledger.';
