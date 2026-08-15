/**
 * File: lib/payment-marks.ts
 * WHAT THE INVOICE SAYS A CUSTOMER CAN PAY WITH — derived from the garage's real Stripe
 * capabilities, never from a fixed list we hope is true.
 *
 * A mark on a document is a promise. Printing "Klarna" on the invoice of a garage whose account
 * cannot take Klarna sends a customer to a payment method that will not be offered, and they ring
 * the garage about it. So the source is the account's own capabilities map, mirrored on
 * ProviderConnection by the one writer that already receives it.
 *
 * ── ONLY `active` COUNTS ────────────────────────────────────────────────────────────────────────
 * Stripe reports `active` | `pending` | `inactive`. `pending` means requested and not yet granted —
 * a capability the garage might get next week is not one their customer can use today.
 *
 * ── WHY THERE IS NO AMEX MARK ───────────────────────────────────────────────────────────────────
 * Deliberate, and worth the paragraph because its absence looks like an oversight. Stripe exposes
 * ONE card capability — `card_payments` — covering every brand; there is no per-account signal for
 * American Express, Diners, or anything else. So an Amex mark could only ever be a guess, and the
 * cost of guessing wrong is a customer arriving with the one card the garage cannot take. Visa and
 * Mastercard are named because `card_payments: active` in GB means both, always. If a per-brand
 * signal ever appears, this is the one function to change.
 *
 * ── TEXT, NOT LOGOS ─────────────────────────────────────────────────────────────────────────────
 * These render as words. Brand logos would mean shipping Visa/Mastercard artwork inside the PDF and
 * complying with each scheme's usage rules on size, clear space and placement — a real licensing
 * question, not a design preference. Words carry the same information and make no promises about
 * trademark use. Revisit deliberately if the marks are ever wanted as artwork.
 */

export type PaymentMark = { key: string; label: string };

/**
 * capability → the marks it justifies, in the order a customer reads them. Cards first because they
 * are what nearly everyone uses; wallets and pay-later after.
 *
 * NOT EXHAUSTIVE ON PURPOSE. Stripe reports around fifty capabilities and most are irrelevant to a
 * UK garage. An unmapped capability contributes nothing rather than rendering a raw key like
 * `bancontact_payments` on an invoice — silence beats a string the customer cannot read.
 */
const MARKS: Record<string, PaymentMark[]> = {
  card_payments: [
    { key: 'visa', label: 'Visa' },
    { key: 'mastercard', label: 'Mastercard' },
  ],
  link_payments: [{ key: 'link', label: 'Link' }],
  bacs_debit_payments: [{ key: 'bacs', label: 'Bacs Direct Debit' }],
  klarna_payments: [{ key: 'klarna', label: 'Klarna' }],
  paypal_payments: [{ key: 'paypal', label: 'PayPal' }],
  amazon_pay_payments: [{ key: 'amazon_pay', label: 'Amazon Pay' }],
  revolut_pay_payments: [{ key: 'revolut_pay', label: 'Revolut Pay' }],
};

/** The order marks appear in, independent of the order Stripe happens to return capabilities. */
const ORDER = ['visa', 'mastercard', 'link', 'paypal', 'amazon_pay', 'revolut_pay', 'klarna', 'bacs'];

/**
 * Marks for a connection's stored capabilities. Pure, so the gate asserts the real rule.
 *
 * Returns EMPTY for null capabilities — a connection that has never synced knows nothing, and
 * "we don't know yet" must render as no marks rather than as a default set. The document simply
 * omits the row; it never says "no payment methods", which would be false.
 */
export function paymentMarks(capabilities: unknown): PaymentMark[] {
  if (!capabilities || typeof capabilities !== 'object') return [];
  const caps = capabilities as Record<string, unknown>;
  const out = new Map<string, PaymentMark>();
  for (const [cap, marks] of Object.entries(MARKS)) {
    if (caps[cap] !== 'active') continue;
    for (const m of marks) out.set(m.key, m);
  }
  return ORDER.map((k) => out.get(k)).filter(Boolean) as PaymentMark[];
}

/** "Visa, Mastercard and Link" — for a line of prose. Empty string when there is nothing to say. */
export function marksSentence(marks: PaymentMark[]): string {
  const l = marks.map((m) => m.label);
  if (l.length === 0) return '';
  if (l.length === 1) return l[0];
  return `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}
