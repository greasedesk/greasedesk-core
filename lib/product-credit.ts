/**
 * File: lib/product-credit.ts
 * THE MAKER'S MARK — one line at the foot of every customer document.
 *
 *     Created with GreaseDesk · greasedesk.com
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────────────────────────
 * "Sent from my iPhone", not a logo. A customer files an invoice, sells the car three years later,
 * opens the folder to find the service history — and the mark is there. It is small, muted, and
 * unobtrusive on purpose: a document that advertises at its reader is a document the garage would
 * be embarrassed to hand over.
 *
 * ── IT IS A MAKER'S MARK, NOT A SENDER ──────────────────────────────────────────────────────────
 * The garage is the supplier. The invoice is theirs, the VAT is theirs, and the money is owed to
 * them. Two things keep this line from reading as though GreaseDesk issued the document, and both
 * are load-bearing:
 *
 *   1. "with", never "by". "Created by GreaseDesk" claims authorship of the content — the figures,
 *      the findings, the advice. "with" names the tool, the way "Made with Squarespace" does.
 *   2. ADJACENCY. It renders directly beneath the garage's own name on every surface. That is what
 *      actually defuses it, more than the wording — so a new document type must put it under the
 *      garage's identity, not float it alone in a corner.
 *
 * The supplier identification a customer and HMRC both look for — name, address, VAT number —
 * stays at the TOP of the document and is untouched by this.
 *
 * ── DOCUMENTS ONLY. NOT EMAIL ───────────────────────────────────────────────────────────────────
 * An email already has a sender, and a line under a message from a garage reads as who sent it
 * rather than what made it. The adjacency argument above does not hold in an inbox. Considered and
 * declined 2026-08-20; raise it as its own decision if it ever comes up, do not add it by analogy.
 *
 * ── AND IT IS NOT REMOVABLE. THIS IS DELIBERATE ─────────────────────────────────────────────────
 * There is no setting, no tier that hides it and no prop that suppresses it, and that is not an
 * oversight to be tidied up by whoever next reads this file. The subscription price is low, and
 * the recognition this line buys is part of what the price is low IN EXCHANGE FOR. Removing it —
 * or adding a toggle "for the bigger customers" — gives away the consideration and keeps the
 * price. If that trade is ever revisited it is a commercial decision made deliberately, not a
 * feature request implemented quietly.
 */
import { COMPANY } from '@/lib/company-info';

/** The words. One string, so no surface can drift into its own phrasing. */
export const CREDIT_PREFIX = 'Created with GreaseDesk';

/** The domain as a human reads it — no scheme, because a document is not a browser. */
export const CREDIT_DOMAIN = COMPANY.siteUrl.replace(/^https?:\/\//, '');

/** Where it points when the surface can be clicked. */
export const CREDIT_HREF = COMPANY.siteUrl;

/** The whole line, for surfaces that cannot compose (the PDF's text runs). */
export const CREDIT_LINE = `${CREDIT_PREFIX} · ${CREDIT_DOMAIN}`;
