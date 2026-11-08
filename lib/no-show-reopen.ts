/**
 * File: lib/no-show-reopen.ts
 * REOPENING A NO-SHOW: back to the status it held, never to a fixed destination.
 *
 * ── WHY THIS IS NOT A TRANSITION ────────────────────────────────────────────────────────────────
 * The table said `no_show -> draft` and the UI offered no way to reach it, so for as long as the
 * banner has promised "Reopen it if they arrive" the only honest answer was a duplicate card. But
 * the fix is not to surface that edge: `draft` was the wrong destination. Measured on production
 * 2026-11-07, of the 13 cards marked no-show, ELEVEN were `accepted`, one `quoted`, one `draft`.
 * Sending all thirteen to `draft` would un-accept eleven accepted quotes.
 *
 * And it would do it invisibly. A status change does not clear `accepted_at`, so the card would sit
 * at `draft` carrying an acceptance timestamp — while lib/acceptance-provenance's
 * SPINE_AMBIGUOUS_ACCEPTANCE lists `draft: false`, so `cardWasAccepted()` answers FALSE for a draft
 * card whatever the column holds. The evidence of the acceptance would still be on the row and the
 * one function that reads it would say no.
 *
 * A from->to table cannot express "back to whatever it was", so `no_show` now has NO exit at all —
 * the same shape `no_charge` already has — and this module is the door. See `reBookingDoor`, which
 * still names 'reopen' for both so a refusal can tell someone what to do instead.
 *
 * ── THE SPLIT, AND WHY IT IS THIS ONE ───────────────────────────────────────────────────────────
 * `refuseReopenNoShow` is pure and decides everything except authority; the route re-derives
 * `permitted` from the session and the site. That is exactly how no_charge's `refuseReopen` is
 * built, and the reason is that authority is a question about a USER — a gate can ask this
 * predicate every refusal without a session, and a hidden button is not a guard either way.
 */
import type { Prisma } from '@prisma/client';
import type { JobStatus } from '@/lib/jobcard-status';
import { writeAudit } from '@/lib/audit';

export type NoShowReopenRefusal = { code: 'not_permitted' | 'not_no_show' | 'no_prior_status'; message: string };

/**
 * May this card be reopened, and is there anywhere to put it?
 *
 * ── A NULL PRIOR STATUS REFUSES. IT DOES NOT DEFAULT ───────────────────────────────────────────
 * Defaulting to `draft` would be precisely the silent un-accepting the column exists to prevent,
 * and it would be worst on the oldest cards — the ones most likely to have been accepted. So the
 * refusal says so and sends the user to set the status by hand, which is the same answer
 * no_charge's reopen gives for the same reason.
 */
export function refuseReopenNoShow(args: {
  status: JobStatus | string;
  priorStatus?: JobStatus | string | null;
  /** Re-derived server-side from role + site — never a client claim. */
  permitted: boolean;
}): NoShowReopenRefusal | null {
  if (!args.permitted) {
    return { code: 'not_permitted', message: 'Only a manager or admin can reopen a job card closed as a no-show.' };
  }
  if (args.status !== 'no_show') {
    return { code: 'not_no_show', message: 'This card is not closed as a no-show.' };
  }
  if (!args.priorStatus) {
    return {
      code: 'no_prior_status',
      message: 'This card does not record what it was before the no-show, so it cannot be reopened automatically. Set the status directly.',
    };
  }
  return null;
}

/**
 * Reopen it. The caller has already asked `refuseReopenNoShow` and re-derived authority.
 *
 * ── THE STAMP IS CLEARED, AND THE AUDIT KEEPS EVERY CYCLE ──────────────────────────────────────
 * Same rule as no_charge's reopen: the closure is over, so its column goes back to NULL. Leaving a
 * stale `no_show_prior_status` on a live card would make it look closed when it is not, and would
 * let a second reopen fire against a status the card no longer holds.
 *
 * ── THE ORIGINAL status.no_show ROW IS NEVER TOUCHED ───────────────────────────────────────────
 * The reversal is its OWN event. AuditLog is append-only by standing rule, and a trail that edits
 * the close to say it was undone loses the fact that it happened at all — which is the fact a
 * customer with form is judged on. `status.no_show_reversed` names where the card went back to;
 * clause B adds the reason the garage gives for it.
 */
export async function reopenNoShow(
  tx: Prisma.TransactionClient,
  args: { groupId: string; jobCardId: string; actorUserId: string | null; reason?: string | null },
): Promise<{ ok: true; restoredTo: JobStatus } | { ok: false; refusal: NoShowReopenRefusal }> {
  const card = await tx.jobCard.findUnique({
    where: { id: args.jobCardId },
    select: { status: true, no_show_prior_status: true },
  });
  // Re-read INSIDE the transaction rather than trusting what the caller looked at: the route
  // checked a row it fetched before the tx opened, and the status is exactly the field another
  // writer may have moved in between. `permitted: true` because authority is the route's question
  // and it has already answered it — this call is about the card's state at the moment of writing.
  const refusal = refuseReopenNoShow({
    status: card?.status ?? 'draft',
    priorStatus: card?.no_show_prior_status ?? null,
    permitted: true,
  });
  if (refusal) return { ok: false, refusal };

  const restoredTo = card!.no_show_prior_status as JobStatus;
  await tx.jobCard.update({
    where: { id: args.jobCardId },
    data: { status: restoredTo as never, no_show_prior_status: null },
  });
  await writeAudit(tx, {
    groupId: args.groupId,
    userId: args.actorUserId,
    jobCardId: args.jobCardId,
    action: 'status.no_show_reversed',
    diff: { restoredTo, ...(args.reason?.trim() ? { reason: args.reason.trim().slice(0, 500) } : {}) },
  });
  return { ok: true, restoredTo };
}
