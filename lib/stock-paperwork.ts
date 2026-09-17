/**
 * File: lib/stock-paperwork.ts
 *
 * WHAT THE STOCK BOOK KNOWS ABOUT A FIELD — and the difference between "not there" and "not asked".
 *
 * Pure and client-safe: no prisma. The entry screen, the writer and the book read one decision.
 *
 * ── THREE STATES, NOT TWO ───────────────────────────────────────────────────────────────────────
 *
 *   recorded       the field holds a value
 *   not_supplied   a person LOOKED at the paperwork and it was not there — they said so, at entry,
 *                  by ticking "not on the paperwork". A FACT ABOUT THE RECORD, not a blank.
 *   not_recorded   nobody was ever asked. Every car taken in before these fields existed reads this
 *                  way, LC09XFU included — and the book must SAY so rather than look finished.
 *
 * A single nullable column cannot tell the second from the third, which is why the ticks are stored
 * as their own list (`not_on_paperwork`) rather than inferred from a NULL.
 *
 * ── A BLANK IS NEVER SILENT ─────────────────────────────────────────────────────────────────────
 *
 * Where these fields are asked for, each one must be filled OR ticked. Blank-and-unticked is refused
 * and the refusal names the field; filled-AND-ticked is refused too, because one of the two is wrong.
 */

export const PURCHASE_PAPERWORK_KEYS = ['seller_name', 'purchase_ref', 'mileage', 'make_model', 'vin', 'colour'] as const;
export const SALE_PAPERWORK_KEYS = ['buyer_name', 'buyer_address', 'receipt_ref', 'sale_mileage'] as const;
export type PurchasePaperworkKey = (typeof PURCHASE_PAPERWORK_KEYS)[number];
export type SalePaperworkKey = (typeof SALE_PAPERWORK_KEYS)[number];
export type PaperworkKey = PurchasePaperworkKey | SalePaperworkKey;

export const PAPERWORK_LABELS: Record<PaperworkKey, string> = {
  seller_name: 'Seller',
  purchase_ref: 'Purchase invoice or receipt number',
  mileage: 'Mileage at purchase',
  make_model: 'Make and model',
  vin: 'VIN',
  colour: 'Colour',
  buyer_name: 'Buyer',
  buyer_address: "Buyer's address",
  receipt_ref: 'Sales receipt number',
  sale_mileage: 'Mileage at sale',
};

/** What the book prints. "Not supplied" says somebody looked; "not recorded" says nobody did. */
export const NOT_SUPPLIED_WORDS = 'not supplied';
export const NOT_RECORDED_WORDS = 'not recorded';

export type PaperworkField =
  | { state: 'recorded'; value: string }
  | { state: 'not_supplied' }
  | { state: 'not_recorded' };

const filled = (v: unknown): v is string | number =>
  (typeof v === 'string' && v.trim().length > 0) || (typeof v === 'number' && Number.isFinite(v));

/**
 * ONE READER for every field of the book. A tick wins only over an EMPTY value — a value and a tick
 * together cannot be written (checkPaperwork refuses it), so reading one here means a row was written
 * around the door, and the value, being a fact, is what gets shown.
 */
export function paperworkField(value: unknown, key: PaperworkKey, notOnPaperwork: readonly string[] | null | undefined): PaperworkField {
  if (filled(value)) return { state: 'recorded', value: String(value).trim() };
  if ((notOnPaperwork ?? []).includes(key)) return { state: 'not_supplied' };
  return { state: 'not_recorded' };
}

export function paperworkText(f: PaperworkField): string {
  if (f.state === 'recorded') return f.value;
  return f.state === 'not_supplied' ? NOT_SUPPLIED_WORDS : NOT_RECORDED_WORDS;
}

/**
 * EVERY FIELD FILLED OR TICKED, and never both. Returns the refusal naming the FIRST field at fault,
 * in the order the keys are listed, so the screen and the server agree on which one a person fixes.
 */
export function checkPaperwork(
  keys: readonly PaperworkKey[],
  values: Partial<Record<PaperworkKey, unknown>>,
  ticked: unknown,
): string | null {
  if (!Array.isArray(ticked) || ticked.some((t) => typeof t !== 'string')) {
    return 'The list of things not on the paperwork could not be read.';
  }
  const unknownTick = (ticked as string[]).find((t) => !(keys as readonly string[]).includes(t));
  if (unknownTick) return `“${unknownTick}” is not a field that can be marked as not on the paperwork here.`;
  for (const k of keys) {
    const has = filled(values[k]);
    const isTicked = (ticked as string[]).includes(k);
    if (has && isTicked) {
      return `${PAPERWORK_LABELS[k]} is filled in AND ticked as not on the paperwork. One of those is wrong — clear the field or untick it.`;
    }
    if (!has && !isTicked) {
      return `${PAPERWORK_LABELS[k]} is blank. Fill it in, or tick “not on the paperwork” if you looked and it was not there.`;
    }
  }
  return null;
}

/** The fields of a book row that nobody was asked for — what makes a row incomplete rather than finished. */
export function notRecordedLabels(fields: Partial<Record<PaperworkKey, PaperworkField>>): string[] {
  return (Object.keys(fields) as PaperworkKey[])
    .filter((k) => fields[k]?.state === 'not_recorded')
    .map((k) => PAPERWORK_LABELS[k]);
}
