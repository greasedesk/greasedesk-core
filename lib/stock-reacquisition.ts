/**
 * File: lib/stock-reacquisition.ts
 *
 * A CAR YOU SOLD HAS COME BACK. Two transactions wear that sentence, and they are not the same one.
 *
 *   RETURN   the sale is reversed. It should not have stood — faulty, rejected, rescinded. The
 *            customer is credited, output VAT declared on the sale is reversed by a credit note, and
 *            the car's ORIGINAL purchase price and VAT status are restored: that cost base never
 *            stopped being yours, because the sale that replaced it is being undone.
 *
 *   BUYBACK  you bought it back. The original sale STANDS and its VAT was correctly due. This is a
 *            new acquisition at the price you have just paid, and the margin on the next sale is
 *            measured from that price — not from what the car cost you the first time.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ───────────────────────────────────────────────────────────────
 *
 * Getting it wrong in one direction is expensive and quiet. Treating a BUYBACK as a return credits
 * VAT that was properly owed and reinstates a cost base that is no longer yours: output VAT
 * understated, cost overstated, margin understated, on a document that looks entirely normal.
 *
 * And the tempting shortcut is exactly the one that cannot work. "We found an issued invoice for this
 * registration" is TRUE OF BOTH. A match is evidence that the car has been here before and evidence
 * of nothing else — so it may show what it found, and it may never choose. The person says which.
 */

export const REACQUISITION_SOURCES = ['return', 'buyback'] as const;
export type ReacquisitionSource = (typeof REACQUISITION_SOURCES)[number];

export function isReacquisition(source: unknown): source is ReacquisitionSource {
  return (REACQUISITION_SOURCES as readonly string[]).includes(String(source));
}

/**
 * THE MATCH IS EVIDENCE, NOT A DECISION.
 *
 * Deliberately shaped so it CANNOT express a preference: no `suggested`, no `likely`, no default, no
 * ordering that means anything. A caller wanting to preselect a source from this would have to invent
 * the field to do it, which is a visible act rather than a plausible one.
 */
export type PriorSale = {
  disposalId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  soldAt: Date;
  salePence: number | null;
  /** The cost base as it stood on the sold record — what a RETURN restores, and a buyback ignores. */
  originalPurchasePence: number;
  originalVatStatus: string;
};

export type CostBase =
  | { purchasePence: number; vatStatus: string; basis: 'restored' | 'as_paid'; note: string }
  | { refused: string };

/**
 * WHICH PRICE THIS CAR GOES BACK ON THE BOOKS AT. The one place that decision is made, so the store,
 * the page and the gate cannot each reach a different answer.
 *
 * `enteredPence` is what the person typed. A RETURN ignores it — the figure is not theirs to choose,
 * it is what the car cost the first time — and says so rather than silently discarding it.
 */
export function reacquisitionCostBase(args: {
  source: ReacquisitionSource;
  prior: PriorSale | null;
  enteredPence: number;
  enteredVatStatus: string;
}): CostBase {
  if (args.source === 'return') {
    /**
     * A RETURN WITHOUT THE ORIGINAL SALE IS NOT RECORDABLE. There is no cost base to restore and no
     * invoice to credit — so this is refused rather than quietly turned into a buyback, which is the
     * one substitution that would silently misstate VAT.
     */
    if (!args.prior) {
      return {
        refused: 'A return reverses a sale, and there is no sale on this account for this car to '
          + 'reverse. If you are buying a car back that you did not sell, that is a buyback.',
      };
    }
    return {
      purchasePence: args.prior.originalPurchasePence,
      vatStatus: args.prior.originalVatStatus,
      basis: 'restored',
      note: 'The sale is being reversed, so the car goes back on at what it originally cost you and '
        + 'under the VAT status it originally had. The price you were paid is credited, not treated '
        + 'as a purchase price.',
    };
  }

  /**
   * A BUYBACK NEEDS A PRICE, AND IT IS THE ONE JUST PAID. No prior sale is required: a car can be
   * bought back from someone we never sold it to, and the transaction is the same either way.
   */
  if (!(args.enteredPence > 0)) {
    return { refused: 'Say what you paid to buy it back.' };
  }
  return {
    purchasePence: args.enteredPence,
    vatStatus: args.enteredVatStatus,
    basis: 'as_paid',
    note: 'The original sale stands. This is a new acquisition at what you have just paid, and the '
      + 'margin on the next sale is measured from that figure.',
  };
}

/** Does this source raise a credit note? EXACTLY the return branch, stated once. */
export function raisesCreditNote(source: unknown): boolean {
  return source === 'return';
}

/**
 * WHAT THE SCREEN MAY SAY WHEN IT FINDS AN OLD SALE. One sentence of fact and a question — no verb
 * that recommends, no option named first as though it were the usual one.
 */
export function priorSaleNotice(p: PriorSale, money: (pence: number) => string): string {
  const when = p.soldAt.toISOString().slice(0, 10);
  const what = p.salePence === null ? 'no sale price recorded' : money(p.salePence);
  return `You sold this car on ${when}${p.invoiceNumber ? ` on invoice ${p.invoiceNumber}` : ''} for ${what}. `
    + 'Which of these is happening? Nothing is assumed from the match — the two are taxed differently.';
}

/**
 * THE REFUSAL WHEN NOBODY CHOSE. A default here is the whole danger: it would be right about half the
 * time and wrong silently the rest, on the half that reduces a VAT bill.
 */
export const MUST_CHOOSE_REFUSAL =
  'Say whether this is a return or a buyback. Finding the old sale shows the car has been here '
  + 'before and cannot tell which of the two happened, and they are taxed differently.';
