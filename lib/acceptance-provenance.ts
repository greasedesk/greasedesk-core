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

import { statusSubset, type JobStatus } from '@/lib/jobcard-status';

// ── WHETHER ANYONE SAID YES — THE SAME FACT FOR EVERY SURFACE (2026-09-10) ───────────────────────
/**
 * This module answered WHO said yes. It now also answers WHETHER anyone did, because two surfaces
 * were answering that for themselves and agreeing only by coincidence:
 *
 *   • the job card page decided "accepted" as "not draft, quoted or declined" — which labelled a
 *     card CANCELLED FROM QUOTED "Recorded by the garage", for a yes that never happened. Two such
 *     cards on the live tenant on 2026-09-10, neither with an accepted_at nor any acceptance audit.
 *   • the quote list decided it from the LATEST VERSION alone — which filed LO25UGN under
 *     "Awaiting response" while it sat accepted and booked, because its quote was sent an hour
 *     AFTER the acceptance and so was born unanswered.
 *
 * Both were right about the cases each had met. Neither was right about the other's. One predicate,
 * both call it, and quote-worklist-gate proves they agree on every shape.
 *
 * ── THREE KINDS OF CARD STATUS, NOT TWO ─────────────────────────────────────────────────────────
 *   PROVES   — accepted, in_progress, invoiced, paid, done. Every route into these passes through
 *              `accepted` (lib/jobcard-status), so the spine itself is the evidence.
 *   AMBIGUOUS — cancelled, no_show. Reachable from `quoted` WITHOUT anyone saying yes, and equally
 *              from `accepted`. The status cannot tell you which, so the EVIDENCE decides.
 *   NO       — draft, quoted, declined. Nothing has been accepted yet.
 *
 * TOTAL BY CONSTRUCTION: statusSubset fails to compile when a JobStatus is added, until somebody
 * decides which of the three it belongs to. A plain array (QUOTE_DONE_STATUSES is one) would let a
 * new status fall silently into "no".
 */
export const SPINE_PROVES_ACCEPTANCE = statusSubset({
  draft: false, quoted: false, declined: false,
  accepted: true, in_progress: true, invoiced: true, paid: true, done: true,
  cancelled: false, no_show: false,
});
export const SPINE_AMBIGUOUS_ACCEPTANCE = statusSubset({
  draft: false, quoted: false, declined: false,
  accepted: false, in_progress: false, invoiced: false, paid: false, done: false,
  cancelled: true, no_show: true,
});

/**
 * WAS THIS CARD ACCEPTED? The one answer.
 *
 * For an AMBIGUOUS status the evidence is accepted_at (written by lib/quote-acceptance for every
 * acceptance since 2026-08-05) or an accepted version. The audit union that dates older acceptances
 * is deliberately NOT consulted: it would put an AuditLog read on every quote-list row, and on the
 * live tenant it would change nothing — measured 2026-09-10, no cancelled or no-show card relies on
 * audit alone. If that ever stops being true this is the line to revisit, not a reason to guess.
 */
export function cardWasAccepted(
  card: { status: string; accepted_at: Date | null },
  hasAcceptedVersion: boolean,
): boolean {
  const s = card.status as JobStatus;
  if (SPINE_PROVES_ACCEPTANCE.includes(s)) return true;
  if (SPINE_AMBIGUOUS_ACCEPTANCE.includes(s)) return card.accepted_at !== null || hasAcceptedVersion;
  return false;
}

/**
 * WHAT THE CARD PAGE SAYS about acceptance, as one pure function of the card and its versions.
 * NULL when nobody said yes — including a card cancelled before anyone did. Otherwise who: the
 * HIGHEST accepted version's provenance, or 'garage' by construction when there is none.
 */
export function cardAcceptance(
  card: { status: string; accepted_at: Date | null },
  versions: Array<{ version: number; status: string; responded_by_user: string | null; responded_ip: string | null }>,
): AcceptanceProvenance | null {
  const acceptedVersion = [...versions].sort((a, b) => b.version - a.version).find((v) => v.status === 'accepted') ?? null;
  if (!cardWasAccepted(card, acceptedVersion !== null)) return null;
  return acceptanceProvenance(acceptedVersion);
}

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
