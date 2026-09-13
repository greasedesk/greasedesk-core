/**
 * File: lib/stock-vat-fraction.ts
 * THE MARGIN-SCHEME DIVISOR, alone in a leaf that imports nothing.
 *
 * VAT on a VAT-inclusive margin at 20% is one sixth. lib/purchase-model holds the same constant for
 * the same reason and does not export it; duplicating the NUMBER in two files would be two places for
 * one rule, so this file is the one both can share when the model is next touched. It is here rather
 * than in lib/stock because lib/stock is imported by a page and a leaf that imports nothing is the
 * cheapest thing to be sure about.
 */
export const VAT_FRACTION_DIVISOR = 6;
