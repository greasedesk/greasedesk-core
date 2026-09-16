/**
 * File: lib/stock-sale-rules.ts
 *
 * SELLING A CAR — the words and the arithmetic, with no database, so the page and the writer read
 * the same rule. The transaction lives in lib/stock-sale.
 *
 * ── WHAT A SALE IS, AND IS NOT ──────────────────────────────────────────────────────────────────
 *
 * A sale is ONE fact with four parts that must never be seen apart: the disposal, the ownership
 * moving to the buyer, the sale card, and the invoice. lib/stock-sale writes all four in one
 * transaction, so a disposal with no invoice and an invoice on a car still in stock are not states
 * the database can hold — there is no instant between them for anything to fail in.
 *
 * ── PRICE IS NOT PAYMENT ────────────────────────────────────────────────────────────────────────
 *
 * The price is the consideration: the invoice total, the book's sale figure, and the base the VAT
 * is worked out from. How it is settled — cash, card, finance, or a car taken in part-exchange — is
 * a separate fact recorded against the invoice afterwards. Kept apart deliberately, because
 * part-exchange arrives in the next slice as a way of SETTLING, and must not have to change what a
 * sale is. A trade-in shown as a negative line would cut the declared selling price and understate
 * the VAT on the whole car.
 */
import { VAT_FRACTION_DIVISOR } from '@/lib/stock-vat-fraction';

/**
 * The API's old `dispose` action with a sale kind would record a disposal and mint nothing — the
 * exact half-state the sale path exists to make impossible. No screen called it, which is precisely
 * how such a state arrives six months later: reachable, uncalled, and forgotten. It refuses, and
 * says where to go instead.
 */
export const SALE_PATH_REFUSAL =
  'A sale is recorded with "Sell this car" on the car’s own page, which raises the invoice and '
  + 'moves the car to its buyer in the same step. Recording the disposal on its own would leave a '
  + 'sold car with no invoice.';

/**
 * TRADED OUT HAS A LABEL AND NO DEFINITION. It stays unreachable until part-exchange gives it one:
 * an option nobody can explain is worse than an absent one, because it gets chosen.
 */
export const TRADED_OUT_UNDEFINED_REFUSAL =
  '"Traded out" is not usable yet — what it means will be settled with part-exchange. If the car '
  + 'was sold, use "Sell this car".';

/** A buyer is a real customer: either one already on the books, or one created with enough to address an invoice to. */
export type BuyerInput =
  | { customerId: string }
  | { name: string; address: string; phone?: string | null; email?: string | null };

/**
 * WHAT A BUYER NEEDS, AT THE POINT OF SALE.
 *
 * NAME AND ADDRESS, not deferrable: the invoice is a VAT document addressed to them, and the
 * addressee freezes at issue — an address added next week would never reach the document already in
 * their hands. Phone and email are contact details, not document facts, and may follow.
 */
export function buyerRefusal(b: Partial<{ customerId: unknown; name: unknown; address: unknown }> | null | undefined): string | null {
  if (!b) return 'Say who is buying the car.';
  if (typeof b.customerId === 'string' && b.customerId.trim()) return null;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const address = typeof b.address === 'string' ? b.address.trim() : '';
  if (!name) return 'Say who is buying the car.';
  if (!address) return 'The buyer’s address is needed now — it is printed on the invoice, and the invoice cannot be changed to add it later.';
  return null;
}

/**
 * A PICKED customer needs an address too. Picking is not a way round the rule: the invoice is
 * addressed to whoever is picked, and an address added to them afterwards never reaches it.
 */
export const PICKED_BUYER_NO_ADDRESS =
  'That customer has no address on file, and the invoice needs one. Add it to the customer, then sell.';

/** A sale is a fact that has happened. The same guardrail as any document date. */
export const SALE_DATE_IN_FUTURE_REFUSAL = 'A sale cannot be dated in the future.';

/**
 * ── THE SALE INVOICE IS DATED BY THE SALE, AND STAYS THAT WAY ───────────────────────────────────
 *
 * Two dates for one sale — the disposal in the stock book and the invoice's document date — can fall in
 * different quarters: a car sold on the last Saturday of March and recorded on the Monday. That is a
 * defect waiting for a quarter end. So the invoice takes its date FROM the disposal when it is minted,
 * and the manager's "edit issue date" refuses on a car sale rather than letting the two part again with
 * one click. Which of the two is the legal tax point is the accountant's call; that they agree is ours.
 */
export const SALE_INVOICE_DATE_LOCKED =
  'This invoice is dated by the sale itself, so the stock book and the invoice fall in the same period. '
  + 'Its date cannot be changed here.';

/**
 * ── THE CONFIRMATION, BEFORE A PERMANENT NUMBER IS MINTED ───────────────────────────────────────
 *
 * The sale form's price box could arrive already filled — on the first real sale it read £2,000, the
 * car's PROJECTED price, where the agreed one was £1,200. A form that goes straight from typing to
 * minting lets a pre-filled figure through unread. This turns every field into a sentence that has to
 * be read before the button that mints: the car, the buyer, the address, the price, the date, the
 * scheme, and that the number is permanent.
 *
 * Months are written out by hand, not by toLocaleDateString: en-GB now prints September as "Sept", and
 * a confirmation whose wording drifts with the runtime is not one sentence.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function saleDateLabel(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : isoDay;
}
export function salePriceLabel(pence: number): string {
  const pounds = Math.floor(pence / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `£${pounds}.${String(pence % 100).padStart(2, '0')}`;
}
export const saleSchemeLabel = (vatStatus: string): string =>
  vatStatus === 'qualifying' ? 'VAT qualifying, with VAT shown on the invoice' : 'margin scheme';

export const SALE_NUMBER_PERMANENT = 'This invoice number is permanent.';

export function saleConfirmation(a: {
  registration: string; description?: string | null; buyerName: string; buyerAddress: string;
  pricePence: number; soldAtIsoDay: string; vatStatus: string;
}): { sentence: string; rows: Array<[string, string]> } {
  const address = a.buyerAddress.split(/\n+/).map((l) => l.trim()).filter(Boolean).join(', ');
  const car = a.description ? `${a.registration} (${a.description})` : a.registration;
  return {
    sentence: `${a.registration} to ${a.buyerName.trim()}, ${address}, for ${salePriceLabel(a.pricePence)} on `
      + `${saleDateLabel(a.soldAtIsoDay)}, ${saleSchemeLabel(a.vatStatus)}. ${SALE_NUMBER_PERMANENT}`,
    rows: [
      ['Car', car],
      ['Buyer', a.buyerName.trim()],
      ['Address', address],
      ['Price', salePriceLabel(a.pricePence)],
      ['Date sold', saleDateLabel(a.soldAtIsoDay)],
      ['VAT', saleSchemeLabel(a.vatStatus)],
    ],
  };
}

export type OpenPrepCard = { id: string; status: string };

/**
 * WHICH PREP CARDS ARE STILL OPEN. A prep card is never invoiced, so "open" is everything that is not
 * finished or abandoned. Written as the CLOSED set, because a new status the list does not name
 * should be treated as open — that errs towards the warning, never towards silence.
 */
export const PREP_CLOSED_STATUSES = ['done', 'cancelled', 'no_show', 'declined', 'invoiced', 'paid'] as const;

export function isOpenPrepStatus(status: string): boolean {
  return !(PREP_CLOSED_STATUSES as readonly string[]).includes(status);
}

/**
 * THE WARNING, AND IT NAMES THE CONSEQUENCE. Not a generic are-you-sure: a car sells when it sells —
 * a buyer with cash on a Saturday does not wait for a card to be closed — so this never refuses. But
 * what it costs has to be on the screen in words: selling freezes the car's costs NOW, and parts
 * added to that card afterwards will not reach the book. And it says what to do about it.
 */
export function openPrepWarning(registration: string, open: OpenPrepCard[]): string | null {
  if (!open.length) return null;
  const which = open.length === 1 ? 'an open prep card' : `${open.length} open prep cards`;
  const that = open.length === 1 ? 'that card' : 'those cards';
  return `${registration} has ${which}. Selling freezes its costs now, and anything added to ${that} `
    + 'afterwards will not reach the book. If the work is done, close the card first. If it is not, '
    + 'selling now means any late parts land outside this car’s cost.';
}

/**
 * THE ONE LINE A SALE INVOICE CARRIES, built for the scheme — because the invoice freeze copies each
 * line's STORED VAT rather than recomputing it.
 *
 *   margin      the whole price, at 0%. The VAT exists inside the price and is accounted for on the
 *               MARGIN in the stock book; putting 20% on the line would declare output tax on the
 *               price, which is exactly the qualifying arithmetic this car is not subject to.
 *   qualifying  VAT a sixth of the gross, net the rest, at 20% — the ordinary VAT invoice. Worked from
 *               the gross down, so the total is the price to the penny rather than 1.2 × a rounded net.
 *
 * The price is GROSS in both cases: the number agreed with the buyer and handed over.
 */
export function saleLine(pricePence: number, vatStatus: string): {
  unitPricePounds: string; vatRate: number; vatAmountPounds: string;
} {
  if (vatStatus === 'qualifying') {
    const vat = Math.round(pricePence / VAT_FRACTION_DIVISOR);
    return { unitPricePounds: ((pricePence - vat) / 100).toFixed(2), vatRate: 20, vatAmountPounds: (vat / 100).toFixed(2) };
  }
  return { unitPricePounds: (pricePence / 100).toFixed(2), vatRate: 0, vatAmountPounds: '0.00' };
}

/** What the line says. The car, identified the way the buyer's V5C will identify it. */
export function saleLineDescription(v: { registration: string; make?: string | null; model?: string | null; year?: number | null }): string {
  const what = [v.year, v.make, v.model].filter((x) => x !== null && x !== undefined && String(x).trim()).join(' ');
  return what ? `Sale of ${what}, registration ${v.registration}` : `Sale of vehicle, registration ${v.registration}`;
}
