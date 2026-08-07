/**
 * File: lib/quote-acceptance.ts
 * THE one place a quote becomes accepted. Every path that says yes on a customer's behalf calls
 * this — as every send goes through sendNotification and every commission through the engine.
 *
 * ── THE FAULT IT CLOSES ─────────────────────────────────────────────────────────────────────────
 * Acceptance was written by four paths producing three audit actions and inconsistent version
 * state. `jobcard-accept` (accept & book) never touched QuoteVersion at all, so a card could read
 * `accepted` while its live version still read `sent` — orphaned, and still shown as Awaiting on
 * the quotes list. Verbal acceptance updated a version only `if (live)`, so a card that never had
 * one recorded the fact nowhere except an audit row. One rule, several expressions: the same shape
 * of fault as the count-versus-list divergence this thread began with.
 *
 * ── WHY A COLUMN AND NOT A MINTED VERSION ───────────────────────────────────────────────────────
 * Minting a QuoteVersion on verbal acceptance would give acceptance one dated home and read
 * beautifully. It would also change what customers are billed. lib/invoice-issue makes the invoice
 * a COLUMN COPY of the accepted version's frozen lines when one exists, and falls through to live
 * JobCardItem when it does not. Mint a version at the handshake and the parts found on the ramp an
 * hour later are silently not billed — no error, no warning, just less money. 96% of real quoting
 * is verbal (197 of 205 accepted-or-beyond cards on the live tenant carry no version at all), so
 * that would be the DEFAULT path, not an edge case. Hence `JobCard.accepted_at`: one nullable
 * column, written here, touching no billing path.
 *
 * ── ONE ACTION, WITH THE ROUTE IN THE DIFF ──────────────────────────────────────────────────────
 * `quote.accepted` is the action, and `via` says which door it came through. `accept.booked` and
 * `quote.accepted_verbal` are NO LONGER WRITTEN but remain in history — AuditLog is append-only,
 * and those rows are the only dated evidence for the acceptances that predate this file. Any
 * reader reaching back past 2026-08-05 must take the UNION of all three.
 *
 * ── WHAT IS NOT AN ACCEPTANCE ───────────────────────────────────────────────────────────────────
 * The two importers (pages/api/historical-import, pages/api/import/commit) create cards already at
 * `accepted`. They do not call this and must not: they are records of COMPLETED work that was
 * never quoted and never accepted by anyone. Their `accepted_at` stays null, which is the honest
 * answer — nobody said yes, because nobody was ever asked.
 */
import type { Prisma } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { findTransition, type JobStatus } from '@/lib/jobcard-status';

/** Which door the acceptance came through. Recorded in the audit diff, never in a status. */
export type AcceptVia = 'link' | 'counter' | 'booked';

export type AcceptQuoteArgs = {
  groupId: string;
  jobCardId: string;
  via: AcceptVia;
  /** The staff user who recorded it. NULL = the CUSTOMER acted through their magic link. */
  actorUserId: string | null;
  /** Customer-attested evidence. NULL for a garage-recorded answer — never fabricate it; the
   *  absence is the honest signal that nobody but the garage witnessed the yes. */
  attested: { ip: string | null; userAgent: string | null } | null;
  at: Date;
};

export type AcceptQuoteResult = {
  /** The version that now records the acceptance, or null when the card never had one. */
  versionId: string | null;
  version: number | null;
  /** TRUE when the card was already accepted and this call changed nothing. */
  alreadyAccepted: boolean;
};

/**
 * Accept the card's live quote. Runs INSIDE the caller's transaction so that booking, acceptance
 * and audit either all land or none do.
 *
 * IDEMPOTENT. A second call returns `alreadyAccepted` and writes nothing — no duplicate audit row,
 * and crucially no second `accepted_at`, which would move the date every time somebody clicked
 * twice. Idempotency is keyed on the CARD, not the version, because a card can legitimately hold an
 * accepted v1 and a later sent v4 (see quotePriceUnconfirmed) and that is not a re-acceptance.
 */
export async function acceptQuote(tx: Prisma.TransactionClient, args: AcceptQuoteArgs): Promise<AcceptQuoteResult> {
  const card = (await tx.jobCard.findFirst({
    where: { id: args.jobCardId, group_id: args.groupId },
    select: { id: true, status: true, accepted_at: true },
  })) as { id: string; status: string; accepted_at: Date | null } | null;
  if (!card) throw new Error('CARD_NOT_FOUND');

  if (card.status === 'accepted') {
    const existing = (await tx.quoteVersion.findFirst({
      where: { job_card_id: card.id, status: 'accepted' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    })) as { id: string; version: number } | null;
    return { versionId: existing?.id ?? null, version: existing?.version ?? null, alreadyAccepted: true };
  }

  // Accepting is a COMMERCIAL transition and must be a legal move from where the card actually is.
  // The table is the authority; this never invents a route the rest of the product does not allow.
  if (!findTransition(card.status as JobStatus, 'accepted')) {
    throw new Error(`ILLEGAL_TRANSITION:${card.status}`);
  }

  // The live offer, if one was ever sent. Only a `sent` version can be accepted — an already
  // answered one has an answer, and a superseded one stopped being the offer.
  const live = (await tx.quoteVersion.findFirst({
    where: { job_card_id: card.id, status: 'sent' },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, gross_pennies: true },
  })) as { id: string; version: number; gross_pennies: number } | null;

  if (live) {
    await tx.quoteVersion.update({
      where: { id: live.id },
      data: {
        status: 'accepted',
        responded_at: args.at,
        responded_by_user: args.actorUserId,          // null = the customer answered
        responded_ip: args.attested?.ip ?? null,      // stays null on a garage-recorded answer
        responded_user_agent: args.attested?.userAgent ?? null,
      },
    });
  }

  // THE DATED HOME, written whether or not a version existed. This is the column every quote
  // report buckets by, and it is why AuditLog never has to become a reporting source.
  await tx.jobCard.update({
    where: { id: card.id },
    data: { status: 'accepted', accepted_at: args.at },
  });

  await writeAudit(tx, {
    groupId: args.groupId,
    userId: args.actorUserId,
    jobCardId: card.id,
    action: 'quote.accepted',
    diff: {
      via: args.via,
      attested: !!args.attested,          // false = garage-recorded, not customer-witnessed
      versionId: live?.id ?? null,
      version: live?.version ?? null,
      grossPennies: live?.gross_pennies ?? null,
      frozenVersion: !!live,              // false = no version; the invoice will use live JobCardItem
      from: card.status,
      at: args.at.toISOString(),
    },
  });

  return { versionId: live?.id ?? null, version: live?.version ?? null, alreadyAccepted: false };
}

/**
 * ── CAN THIS CARD STILL ANSWER A QUOTE? ─────────────────────────────────────────────────────────
 * The transition table is the authority for BOTH answers, so accept and decline can never disagree
 * about whether a card is still open to one.
 *
 * Why this exists: a customer clicked an accept link on a card that had already been INVOICED.
 * acceptQuote threw ILLEGAL_TRANSITION as designed, nothing caught it, and the customer got a 500
 * reading "something went wrong". Meanwhile the DECLINE branch bypassed the check entirely and
 * would happily have marked a version declined on work already billed — the same hole, failing
 * silently instead of loudly, which is worse.
 *
 * `accepted` is answerable-for-accept ONLY: acceptQuote treats a second accept as idempotent (a
 * customer double-tapping on a bad connection must not see an error), but a card that has been
 * accepted cannot then be declined through a stale link.
 *
 * NULL = go ahead.
 */
export type QuoteAnswerRefusal = { code: 'already_actioned'; message: string };

export function refuseQuoteAnswer(cardStatus: string, outcome: 'accepted' | 'declined'): QuoteAnswerRefusal | null {
  if (outcome === 'accepted' && cardStatus === 'accepted') return null; // idempotent re-accept
  if (findTransition(cardStatus as JobStatus, outcome)) return null;
  return {
    code: 'already_actioned',
    // ONE sentence, customer-facing. It must not name the internal status: "invoiced" tells a
    // customer they have been billed for something they were still being asked to approve.
    message: 'This quote has already been actioned — please contact the garage.',
  };
}

