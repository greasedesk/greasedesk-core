/**
 * File: lib/jobcard-transition.ts
 * THE writer for a job-card status change. One function, so the transition table in
 * lib/jobcard-status governs every move rather than only the ones that come through the API.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * A card paid online has to move `invoiced → paid` like any other, but the mover is a webhook with
 * no user and no request. The tempting shortcut is `jobCard.update({ status: 'paid' })` in the
 * webhook — which is a second, ungoverned way to move a card, three lines away from the table that
 * is supposed to be the single source of truth. Instead both callers come here, the table is
 * consulted either way, and an illegal move is refused wherever it originates.
 *
 * ── WHAT THIS DOES *NOT* DO ─────────────────────────────────────────────────────────────────────
 * No authority check. `Transition.kind` decides who may ask, and that is a question about a USER —
 * pages/api/jobcard-status answers it before calling, because it has one. A webhook has no user to
 * authorise: the authority there is the money, already verified by Stripe's signature. Putting a
 * permission check in here would either be dead code or a lie about who acted.
 */
import type { Prisma } from '@prisma/client';
import { findTransition, type JobStatus } from '@/lib/jobcard-status';
import { writeAudit } from '@/lib/audit';

export type TransitionRefusal = { code: 'illegal_transition'; message: string };

/**
 * Move a card, or refuse. `actorUserId` is null for a system actor — a webhook, a cron — and that
 * null is meaningful in the audit trail: it says nobody at the garage did this.
 *
 * Idempotent on the no-op: asking to move a card to the status it already holds succeeds without
 * writing an audit row, because Stripe redelivers and a second `status.paid` in the trail would
 * read as the card having been paid twice.
 */
export async function applyCardTransition(
  tx: Prisma.TransactionClient,
  args: {
    groupId: string; jobCardId: string; from: JobStatus; to: JobStatus; actorUserId: string | null;
    /**
     * Optional free text, written into the AUDIT DIFF — the event's own record — never a column.
     * A no-show's "didn't answer the phone" belongs on the moment it was marked; cancellation has
     * carried no reason since the beginning, and a note that is optional here keeps a no-show from
     * being more ceremonious than a cancellation.
     */
    note?: string | null;
  },
): Promise<{ ok: true; moved: boolean } | { ok: false; refusal: TransitionRefusal }> {
  if (args.from === args.to) return { ok: true, moved: false };

  const tr = findTransition(args.from, args.to);
  if (!tr) {
    return {
      ok: false,
      refusal: { code: 'illegal_transition', message: `Cannot move from ${args.from} to ${args.to}.` },
    };
  }

  await (tx as any).jobCard.update({ where: { id: args.jobCardId }, data: { status: args.to } });
  await writeAudit(tx, {
    groupId: args.groupId,
    userId: args.actorUserId,
    jobCardId: args.jobCardId,
    action: `status.${args.to}` as any,
    diff: { from: args.from, to: args.to, ...(args.note?.trim() ? { note: args.note.trim().slice(0, 500) } : {}) },
  });
  return { ok: true, moved: true };
}
