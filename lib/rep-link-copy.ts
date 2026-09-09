/**
 * File: lib/rep-link-copy.ts
 * WHAT A REP READS WHEN A SIGN-IN LINK DOES NOT WORK — and NOTHING ELSE IN THIS FILE.
 *
 * ── WHY IT IS NOT IN lib/rep-magic-link ─────────────────────────────────────────────────────────
 * It was, and that shipped PrismaClient to the sign-in page. lib/rep-magic-link imports lib/db, as
 * it must — it reads and writes the link rows. pages/rep/enter/[token] called repSpendMessage from
 * the button handler to turn a refusal code into a sentence; that one helper kept the whole module,
 * and lib/db with it, in the browser bundle. PrismaClient's own guard threw on load, and the page's
 * client JavaScript never ran.
 *
 * What that looked like: the page RENDERED — server-side HTML is unaffected — and the button did
 * nothing. Playwright saw the element as visible, enabled and stable, and the click timed out
 * against Next's dev error overlay. In production there is no overlay: the click would simply have
 * done nothing, silently, for every rep on every sign-in.
 *
 * Second instance of this exact shape (lib/magic-link-days is the first, 2026-09-08). Both times a
 * value the BROWSER needs lived in a module the SERVER needs. The rule that keeps them apart:
 * anything the browser reads must live somewhere it can reach without dragging a database client
 * behind it. client-bundle-gate enforces it — and had to be widened to see this one, because it
 * modelled tree-shaking on a page that has no getServerSideProps to shake.
 */

/**
 * HOW LONG A REP SIGN-IN LINK LIVES. Thirty minutes.
 *
 * Not the customer link's fourteen days: this one is a CREDENTIAL, and a credential sitting in an
 * inbox for a fortnight is a credential somebody forwards. A rep who takes longer asks for another
 * — the request form is one field. lib/rep-magic-link re-exports this so server callers keep one
 * import, and the number lives here, once.
 */
export const REP_LINK_MINUTES = 30;

/** The four ways a link can fail. */
export type RepSpendReason = 'not_found' | 'expired' | 'revoked' | 'consumed' | 'rate_limited' | 'suspended';

/**
 * THE SENTENCE THE REP READS.
 *
 * Four refusals, four different things to do about it. "Invalid link" for all of them is what sends
 * somebody to their area manager over a link they merely used twice — and a rep on a forecourt with
 * no way in cannot invoice for the month.
 */
export function repSpendMessage(reason: RepSpendReason | string): string {
  switch (reason) {
    case 'consumed': return 'This link has already been used. Ask for a new one below.';
    case 'expired': return `This link has expired — they last ${REP_LINK_MINUTES} minutes. Ask for a new one below.`;
    case 'revoked': return 'This link was replaced by a newer one. Check for a more recent email, or ask for another.';
    case 'rate_limited': return 'Too many attempts from this connection. Wait an hour and try again.';
    case 'suspended': return 'This account is not active. Speak to your area manager.';
    default: return 'That link is not valid. Ask for a new one below.';
  }
}
