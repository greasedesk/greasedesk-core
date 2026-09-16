/**
 * File: lib/margin-scheme.ts
 *
 * HOW A DOCUMENT PRESENTS VAT — and the one case where showing it would be a false statement.
 *
 * Pure, no imports. The three renderers (the admin invoice page, the PDF, and the shared
 * customer-facing DocumentLines) each build their own markup — React DOM, react-pdf primitives, and
 * a Tailwind table — so the RULE is the only thing they can share, and it is the thing that must not
 * drift. Same shape as showVatTotalLine, for the same reason.
 *
 * ── WHY A MARGIN SALE MAY NOT SHOW VAT ──────────────────────────────────────────────────────────
 *
 * Under the second-hand margin scheme the seller accounts for VAT on the MARGIN, not on the price,
 * and the buyer cannot reclaim any of it. An invoice showing "VAT £1,333.33" on a £8,000 margin car
 * states something untrue twice over: that figure was never charged, and a VAT-registered buyer
 * reading it would reclaim tax that was never paid to HMRC. HMRC Notice 718 requires such an invoice
 * to carry a reference to the scheme and to show no separate VAT.
 *
 * A QUALIFYING car is the opposite: input tax was reclaimed when it was bought, output tax is due on
 * the whole selling price, and the invoice is an ordinary VAT invoice. Both are `vehicle_sale`, and
 * the series cannot tell them apart — Invoice.vat_position does.
 *
 * ── THE WORDING IS A COMPLIANCE CHOICE, KEPT IN ONE PLACE ───────────────────────────────────────
 *
 * MARGIN_SCHEME_STATEMENT is the exact sentence that prints on the document. It sits here, alone,
 * so it can be changed on an accountant's advice with one edit and no search — not because this file
 * knows it is right. If you are here to change it, change it here and nowhere else.
 */

/** Printed on a margin-scheme sale, and on nothing else. */
export const MARGIN_SCHEME_STATEMENT =
  'Margin scheme — second-hand goods. VAT is not shown separately and cannot be reclaimed on this invoice.';

export type VatPresentation =
  /** An ordinary VAT invoice: subtotal, the per-rate lines, and the total. */
  | 'normal'
  /** ONE figure, the price paid. No VAT anywhere, plus MARGIN_SCHEME_STATEMENT. */
  | 'margin_scheme'
  /** The garage is not VAT registered, so there is no VAT to show and nothing to explain. */
  | 'not_registered';

/**
 * WHICH PRESENTATION, from the two facts that decide it.
 *
 * NOT REGISTERED WINS. A garage that is not VAT registered cannot be on the margin scheme, so a
 * margin statement on its invoice would claim a registration it does not have. `vat_position` can
 * still be 'margin' on such a row — the stock book's arithmetic is about the car, not about the
 * garage — so the order of these two tests is load-bearing.
 *
 * `vatPosition` is null on every invoice that is not a car sale, which is all of them today.
 */
export function vatPresentation(doc: { vatRegistered: boolean; vatPosition?: string | null }): VatPresentation {
  if (!doc.vatRegistered) return 'not_registered';
  return doc.vatPosition === 'margin' ? 'margin_scheme' : 'normal';
}

/** Does this document show a VAT breakdown at all? */
export const showsVatBreakdown = (p: VatPresentation): boolean => p === 'normal';

/** Does it carry the margin-scheme statement? */
export const showsMarginStatement = (p: VatPresentation): boolean => p === 'margin_scheme';

/**
 * WHICH FIGURE THE SINGLE TOTAL IS, when there is only one.
 *
 * NOT INTERCHANGEABLE, and this is the trap. An unregistered garage's document has no VAT anywhere,
 * so net IS the price. A MARGIN document suppresses a VAT figure that genuinely exists inside the
 * price — so its single total must be the GROSS, the money the customer actually hands over.
 * Showing the net there would under-state the car by a sixth of its margin and the document would
 * not add up against the payment.
 */
export function singleTotalPennies(
  p: VatPresentation,
  totals: { netPennies: number; grossPennies: number },
): number {
  return p === 'margin_scheme' ? totals.grossPennies : totals.netPennies;
}
