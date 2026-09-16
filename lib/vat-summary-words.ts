/**
 * File: lib/vat-summary-words.ts
 *
 * THE WORDS the VAT summary uses for car sales, shared by its three renderers — the page, the CSV and the
 * accountant's PDF. A LEAF with no imports, deliberately: the page is rendered in the browser, and a
 * constant taken from lib/vat-summary would pull the database client into the client bundle with it.
 *
 * The unclassified line is RED on every renderer and says three things: how many, that they are in NO
 * figure, and that they must be classified before filing. A report that left them out quietly would be
 * believed.
 */
export const unclassifiedHeadline = (n: number): string =>
  `${n} car sale invoice${n === 1 ? '' : 's'} could not be classified and ${n === 1 ? 'is' : 'are'} NOT in these figures.`;

export const UNCLASSIFIED_ACTION = 'Each must be classified before this return is filed.';

export const MARGIN_SECTION_TITLE = 'Cars sold under the margin scheme';

export const marginSectionNote = (taxLabel: string): string =>
  `${taxLabel} is due on the margin — the sale price less the price paid for the car, buyer’s premium included — `
  + 'and is shown here, not in the figures above. How these sales enter total sales is for your accountant.';

export const totalIncludingMarginLabel = (taxLabel: string): string => `Output ${taxLabel} including the margin scheme`;
