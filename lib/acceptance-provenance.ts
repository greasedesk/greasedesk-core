/**
 * File: lib/acceptance-provenance.ts
 * WHO said yes — derived in ONE place, read by every surface that shows an acceptance.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * A garage-recorded acceptance and a customer's own click rendered identically. Since acceptance
 * was unified into one chokepoint both write `quote.accepted`, and the job-card audit view drops
 * `diff_json` — so the only on-screen difference was whether a staff name happened to appear beside
 * the row. An absence is not a statement: a reader could not tell "the customer did this" from "we
 * don't know who did this". Ruling 2026-08-08: a garage-recorded acceptance must SAY SO, in words,
 * on every surface that shows acceptance.
 *
 * ── NO NEW COLUMN. THE GRAIN WAS ALREADY THERE ──────────────────────────────────────────────────
 * quote-accept-verbal has always written the two fields asymmetrically on purpose:
 *     responded_by_user NULL + ip present  → the CUSTOMER clicked their link
 *     responded_by_user SET  + ip null     → the GARAGE recorded it
 * Measured across all 24 accepted versions in production: 9 customer, 7 garage, 8 with neither —
 * and all 8 of those are ZZ script-written fixtures, so the live tenant's grain is complete.
 *
 * ── VERSIONLESS IS GARAGE-RECORDED BY CONSTRUCTION ──────────────────────────────────────────────
 * No version means no magic link was ever minted, so no customer could have clicked one. 219 of the
 * 240 accepted-onwards cards are versionless — this is the COMMON case, not an edge, and it needs
 * no stored flag to be certain about.
 *
 * ── "VERBAL" IS ALREADY TAKEN, AND MEANS SOMETHING ELSE ─────────────────────────────────────────
 * QuoteRow.verbal and QuotesMetrics.acceptedVerbalCount both mean NO VERSION WAS EVER SENT. That is
 * a different axis from who confirmed it: a card can be versioned-and-garage-recorded (the counter
 * button) or versionless-and-garage-recorded (the 219). Reusing the word for provenance would make
 * one figure mean two things, so provenance gets its own vocabulary and never borrows that one.
 */

export type AcceptanceProvenance = 'customer' | 'garage' | 'unknown';

export type ProvenanceFields = {
  responded_by_user: string | null;
  responded_ip: string | null;
} | null;

/**
 * NULL version → 'garage'. Not a guess: no version means no link, and a customer cannot click a
 * link that never existed.
 *
 * Both fields null → 'unknown', and it stays unknown. These are rows written by scripts rather than
 * through the chokepoint; inventing 'garage' for them would be the same sin this module exists to
 * fix, one level down.
 */
export function acceptanceProvenance(v: ProvenanceFields): AcceptanceProvenance {
  if (!v) return 'garage';
  if (v.responded_by_user) return 'garage';
  if (v.responded_ip) return 'customer';
  return 'unknown';
}

/**
 * THE WORDS. Short enough for a chip, honest enough to stand alone. Kept here beside the derivation
 * so a surface cannot render the right value under the wrong label.
 *
 * 'customer' is deliberately the only one that claims a customer acted. 'unknown' says what we do
 * not know rather than defaulting to the flattering answer.
 */
export const PROVENANCE_LABEL: Record<AcceptanceProvenance, string> = {
  customer: 'Confirmed by the customer',
  garage: 'Recorded by the garage',
  unknown: 'Source of confirmation not recorded',
};

/** The same three, as a sentence for a panel rather than a chip. */
export const PROVENANCE_SENTENCE: Record<AcceptanceProvenance, string> = {
  customer: 'The customer confirmed this themselves, through the link they were sent.',
  garage: 'This was recorded by the garage — no customer confirmation was captured.',
  unknown: 'This acceptance predates our record of who confirmed it.',
};

/** TRUE only where a customer personally attested. Use for "is this evidence?" questions — never
 *  treat 'unknown' as attested, which is what reading `!responded_by_user` used to do. */
export const isCustomerAttested = (p: AcceptanceProvenance): boolean => p === 'customer';
