/**
 * File: lib/magic-link-days.ts
 * HOW LONG A CUSTOMER LINK LIVES — one number, and NOTHING ELSE IN THIS FILE.
 *
 * ── WHY IT IS NOT IN lib/magic-link ─────────────────────────────────────────────────────────────
 * It was, and that shipped PrismaClient to the customer pay page. lib/magic-link imports lib/db, as
 * it must — it reads and writes the link rows. pages/c/[token] used this constant in one sentence
 * about expiry ("Quote links stay valid for 14 days"), at MODULE SCOPE, in the half of the page
 * that goes to the browser. Next strips getServerSideProps and the imports used only inside it; an
 * import used anywhere else keeps its whole module, and everything that module imports. So one
 * constant, wanted for a sentence, carried the database client into a customer's browser, where
 * Prisma's own guard threw on load and NO CLIENT JAVASCRIPT RAN.
 *
 * What that looked like: a cookie banner that rendered and could not be dismissed, its effect never
 * publishing --consent-height so nothing reserved space for it, and PayPanel — dynamic, ssr:false —
 * never mounting, so the Pay button was absent rather than broken. Three gates went red naming
 * three different symptoms; the one that got reported was "body padding-bottom 0px".
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a value the browser needs must live somewhere the browser can
 * reach without dragging a database client behind it. client-bundle-gate enforces it.
 */

/**
 * 14 days.
 *
 * Right for a quote — an offer that should be answered while it is still the price — and the same
 * window is used for every customer link so a garage has one number to tell people. The derivation
 * of quote expiry (lib/quotes-list::quoteExpiry) reads this rather than repeating 14, so there is
 * never a second copy to disagree with the first.
 */
export const MAGIC_LINK_DAYS = 14;
