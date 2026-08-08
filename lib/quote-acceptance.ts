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
 * ── RECORDING THAT A LATER VERSION WAS AGREED, ON A CARD THAT HAS MOVED ON ───────────────────────
 * VERSION-LEVEL ONLY. It marks a version accepted and touches the JobCard row NOT AT ALL.
 *
 * The case: BJ65KWV held an accepted v1 at £311.92 and a sent v3 at £701.41, invoiced against v1's
 * lines. The customer agreed v3 by phone. There was no way to record that — acceptQuote refuses
 * because `invoiced` has no legal transition to `accepted`, and it is RIGHT to refuse: the card is
 * invoiced because the work is done, and dragging it back to `accepted` would falsify the spine and
 * undo the invoice's own status. Someone had already unlocked and re-issued that invoice FOUR times
 * trying to fix it by hand, getting v1's lines back every time — faithfully, because v1 was the only
 * accepted version.
 *
 * ── WHY A SECOND FUNCTION AND NOT A FLAG ON acceptQuote ─────────────────────────────────────────
 * acceptQuote does two things: marks the version, and moves the card. Here we want the first
 * without the second. A `skipStatusMove` flag would put "do the half that bypasses the transition
 * table" behind a boolean on the very function the CUSTOMER's magic link calls, one mistaken
 * argument away from letting a stale link rewrite a billed card. Two functions cannot be confused
 * by a flag; `actorUserId` here is NON-NULLABLE, so the shape that means "the customer did this"
 * is unconstructible.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
 *  • No status move, no `accepted_at` (ruling 2026-08-08: the original acceptance date STAYS).
 *  • It does not touch the earlier accepted version. The customer really did accept v1 on 29 July,
 *    with their own IP on the row; deleting that would falsify the record to tidy a report.
 *  • It does not unlock or re-issue. Fusing them would hide a £389 change to a customer's bill
 *    inside a click labelled "accepted". The admin does the money as a separate audited act.
 *  • It mints nothing. The existing accepted-version inheritance in lib/invoice-issue resolves the
 *    HIGHEST accepted version, so re-issue picks up v3 with no new billing code at all.
 *
 * ── THE ACTION IS ITS OWN ───────────────────────────────────────────────────────────────────────
 * `quote.agreed_version`, never `quote.accepted`. quotes-metrics unions the acceptance actions to
 * date historic acceptances, and this event is NOT a card acceptance — folding it in would add a
 * second acceptance to a card that only ever had one.
 *
 * KNOWN IMPRECISION, accepted by ruling rather than worked around: with `accepted_at` left alone,
 * resolveAcceptedAt falls back to the highest accepted version's responded_at, so this card's
 * reported acceptance moves to the recording date and its value from £311.92 to £701.41 — across
 * month boundaries. One date per card cannot express two real acceptances. See lib/quotes-metrics.
 */
export type AgreedVersionRefusal =
  | { code: 'version_not_on_card'; message: string }
  | { code: 'version_not_open'; message: string };

export type RecordAgreedVersionArgs = {
  groupId: string;
  jobCardId: string;
  /** EXPLICIT. Never "the highest sent" — the garage is asserting that a SPECIFIC version was
   *  agreed, and inferring which one is how the wrong figure gets billed. */
  versionId: string;
  /** NON-NULLABLE. A garage-recorded agreement always has a named member of staff behind it. */
  actorUserId: string;
  at: Date;
};

export async function recordAgreedVersion(
  tx: Prisma.TransactionClient,
  args: RecordAgreedVersionArgs,
): Promise<{ version: number; grossPennies: number } | AgreedVersionRefusal> {
  const v = (await tx.quoteVersion.findFirst({
    where: { id: args.versionId, job_card_id: args.jobCardId, group_id: args.groupId },
    select: { id: true, version: true, status: true, gross_pennies: true },
  })) as { id: string; version: number; status: string; gross_pennies: number } | null;

  // Scoped to the card AND the tenant in one query — a versionId from another card (or another
  // garage) is not found, rather than found and then checked.
  if (!v) return { code: 'version_not_on_card', message: 'That quote version is not on this job card.' };

  // ONLY a `sent` version can be agreed. `superseded` was withdrawn when a newer quote went out, so
  // nobody could have agreed to it as the live offer; `accepted`/`declined` already have an answer.
  if (v.status !== 'sent') {
    return {
      code: 'version_not_open',
      message: v.status === 'superseded'
        ? `Version ${v.version} was replaced by a newer quote, so it is no longer the offer. Agree the version the customer was actually shown.`
        : `Version ${v.version} has already been answered (${v.status}).`,
    };
  }

  await tx.quoteVersion.update({
    where: { id: v.id },
    data: {
      status: 'accepted',
      responded_at: args.at,
      responded_by_user: args.actorUserId, // SET + ip null = garage-recorded (lib/acceptance-provenance)
      responded_ip: null,                  // never fabricated: no customer was on the end of a request
      responded_user_agent: null,
    },
  });

  await writeAudit(tx, {
    groupId: args.groupId,
    userId: args.actorUserId,
    jobCardId: args.jobCardId,
    action: 'quote.agreed_version',
    diff: {
      versionId: v.id,
      version: v.version,
      grossPennies: v.gross_pennies,
      attested: false,      // garage-recorded, always — there is no attested route into this function
      cardStatusUnchanged: true,
      at: args.at.toISOString(),
    },
  });

  return { version: v.version, grossPennies: v.gross_pennies };
}

export const isAgreedVersionRefusal = (r: unknown): r is AgreedVersionRefusal =>
  !!r && typeof r === 'object' && 'code' in (r as any);

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

/**
 * CAN THIS CARD BE SENT A QUOTE AT ALL? Asked BEFORE a version is frozen and a link minted.
 *
 * A quote is a question, and there is no point asking one the card cannot answer. Sending on an
 * invoiced card mints a live customer link whose only possible outcome is the refusal above — the
 * customer learns the quote is dead by clicking it, which is the worst place to find out. This is
 * how the BJ65KWV incident happened: the invoice went out at 12:26 and the quote at 12:30.
 *
 * ── IT ASKS ABOUT THE POST-SEND STATUS, AND THAT IS THE WHOLE SUBTLETY ──────────────────────────
 * `draft` has NO transition to `accepted` — the path is draft → quoted → accepted. Testing the
 * CURRENT status would therefore refuse every FIRST send, which is 51 of the 63 quotes ever sent.
 * The status that matters is the one the card will hold when the customer clicks, and quote-send
 * itself performs the draft → quoted move. So we answer for the post-send card.
 *
 * Same predicate as the answer, deliberately: whether a card can be sent a quote and whether it can
 * answer one are the same question asked at two moments, and if they ever disagreed we would either
 * refuse sends that would have worked or mint links that could only fail.
 *
 * `accepted` passes — that is the REVISION path, and refuseQuoteAnswer already treats a re-accept as
 * idempotent. `declined` passes, because declined → accepted is a legal reopen.
 *
 * ── THE PREDICATE IS SHARED; THE WORDING IS NOT ─────────────────────────────────────────────────
 * The refusal above is read by a CUSTOMER and must not name the internal status. This one is read
 * by the GARAGE, who is owed the actual reason and can act on it — so it says which state the card
 * is in and what to do instead. One rule, two audiences.
 */
export type QuoteSendRefusal = { code: 'not_answerable'; status: string; message: string };

const SEND_REFUSAL_REASON: Record<string, string> = {
  invoiced: 'This job has already been invoiced, so a quote can no longer be accepted against it.',
  paid: 'This job has already been invoiced and paid.',
  done: 'This job is closed.',
  in_progress: 'This job is already under way — a quote sent now could not be accepted. Add the extra work to the job and invoice it, or raise a new job card for it.',
  cancelled: 'This job card has been cancelled. Reopen it before quoting.',
};

export function refuseQuoteSend(cardStatus: string): QuoteSendRefusal | null {
  const answerable = cardStatus === 'draft' ? 'quoted' : cardStatus;
  if (!refuseQuoteAnswer(answerable, 'accepted')) return null;
  return {
    code: 'not_answerable',
    status: cardStatus,
    message: SEND_REFUSAL_REASON[cardStatus]
      ?? `A quote cannot be sent on a job card at “${cardStatus}” — the customer would not be able to accept it.`,
  };
}

