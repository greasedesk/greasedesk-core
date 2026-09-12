/**
 * File: lib/job-clock-store.ts
 * THE ONE WRITER of clock sessions. Nothing else inserts, closes or corrects one.
 *
 * ── ONE OPEN SESSION PER TECH, AND HOW IT IS ACTUALLY HELD ──────────────────────────────────────
 * Three things, in this order, and each does a different job:
 *
 *   1. pg_advisory_xact_lock on the tech — two clock-ons for the same person SERIALISE rather than
 *      race. Without it the pattern below is still correct but the loser learns it by having the
 *      unique index reject the insert, i.e. by a P2002.
 *   2. A COUNT-CHECKED CONDITIONAL UPDATE closes whatever is open: `updateMany where ended_at is
 *      null`. The count is the answer to "was anything open?", read from the write itself rather
 *      than from a read that could be stale by the time the write lands.
 *   3. The partial unique index is the BACKSTOP, and is never relied upon. NO CODE PATH CATCHES A
 *      P2002. A caught unique violation poisons the surrounding transaction — Postgres aborts the
 *      whole block, so every statement after the catch dies with 25P02 and code that looks
 *      idempotent is not (lib/commission, 2026-08-16). Catching it here would put that defect
 *      inside the one writer.
 *
 * ── CLOCKING ONTO A SECOND JOB CLOSES THE FIRST ─────────────────────────────────────────────────
 * Not a convenience: a tech cannot be on two cars at once, and forgetting to clock off is the
 * NORMAL failure, not the exceptional one. The closure is recorded with its cause ('superseded'),
 * so a session that ended because the person moved on is distinguishable from one they closed.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveInstant, normaliseCorrectionReason, type ClockSource, type EndCause } from '@/lib/job-clock';

type Tx = Prisma.TransactionClient;

/** Serialise everything about one tech's open state. Transaction-scoped: released on commit or abort. */
async function lockTech(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', userId);
}

/** Close whatever this tech has open. Returns how many were closed — 0 or 1, never more. */
async function closeOpen(tx: Tx, userId: string, at: Date, receivedAt: Date, source: ClockSource, cause: EndCause,
  deviceAt: Date | null): Promise<number> {
  const { count } = await tx.jobClockSession.updateMany({
    // THE PRE-STATE IS THE CONDITION. Not "the row I just read", which may have closed since.
    where: { user_id: userId, ended_at: null },
    data: { ended_at: at, ended_received_at: receivedAt, ended_source: source, ended_cause: cause, device_ended_at: deviceAt },
  });
  if (count > 1) throw new Error(`job-clock: ${count} open sessions for one tech — the partial unique index is missing`);
  return count;
}

export type ClockOnResult = { id: string; supersededCount: number; clamped: boolean };

/**
 * CLOCK ON. `deviceAt` is what an offline phone claimed; omit it when the server is stamping.
 * Returns how many sessions this closed, so the caller can say "you were on VE12 ABC" rather than
 * silently moving somebody.
 */
export async function clockOn(args: {
  groupId: string; userId: string; jobCardId: string; deviceAt?: Date | null; now?: Date;
}): Promise<ClockOnResult> {
  const now = args.now ?? new Date();
  const start = resolveInstant(args.deviceAt ?? null, now);
  return prisma.$transaction(async (tx) => {
    await lockTech(tx, args.userId);
    // The old session ends WHEN THE NEW ONE STARTS. Any other instant would invent time the tech
    // was on neither car, or count them on both.
    const supersededCount = await closeOpen(tx, args.userId, start.at, now, start.source, 'superseded', start.device);
    const row = await tx.jobClockSession.create({
      data: {
        group_id: args.groupId, job_card_id: args.jobCardId, user_id: args.userId,
        started_at: start.at, started_source: start.source, started_received_at: now, device_started_at: start.device,
      },
      select: { id: true },
    });
    return { id: row.id, supersededCount, clamped: start.clamped };
  });
}

export type ClockOffResult = { closed: boolean; clamped: boolean };

/** CLOCK OFF. Closing nothing is not an error — a double-tap, or the outbox delivering twice. */
export async function clockOff(args: { userId: string; deviceAt?: Date | null; now?: Date }): Promise<ClockOffResult> {
  const now = args.now ?? new Date();
  const end = resolveInstant(args.deviceAt ?? null, now);
  return prisma.$transaction(async (tx) => {
    await lockTech(tx, args.userId);
    const count = await closeOpen(tx, args.userId, end.at, now, end.source, 'tech', end.device);
    return { closed: count === 1, clamped: end.clamped };
  });
}

/**
 * A CORRECTION IS A NEW ROW. The original is never altered — the append-only trigger would refuse
 * it anyway, and that is the point: the enforcement does not depend on this function being the only
 * caller. Admin-only; the endpoint holds that through requireAdminApi.
 */
export async function correctSession(args: {
  correctsId: string; byUserId: string; reason: unknown; startedAt: Date; endedAt: Date | null;
}): Promise<{ id: string } | { refused: string }> {
  const reason = normaliseCorrectionReason(args.reason);
  if (!reason) return { refused: 'A correction needs a reason, and a blank one is not a reason.' };
  if (args.endedAt && args.endedAt.getTime() < args.startedAt.getTime()) {
    return { refused: 'A correction cannot end before it starts.' };
  }
  const original = await prisma.jobClockSession.findUnique({
    where: { id: args.correctsId },
    select: { id: true, group_id: true, job_card_id: true, user_id: true, corrects_id: true },
  });
  if (!original) return { refused: 'That session no longer exists.' };
  // A correction of a correction would make "the original" ambiguous. Correct the original instead.
  if (original.corrects_id) return { refused: 'That row is itself a correction — correct the original session.' };
  const now = new Date();
  const row = await prisma.jobClockSession.create({
    data: {
      group_id: original.group_id, job_card_id: original.job_card_id, user_id: original.user_id,
      started_at: args.startedAt, started_source: 'correction', started_received_at: now,
      ...(args.endedAt ? { ended_at: args.endedAt, ended_source: 'correction' as const, ended_received_at: now, ended_cause: 'correction' as const } : {}),
      corrects_id: original.id, correction_reason: reason, corrected_by_user_id: args.byUserId,
    },
    select: { id: true },
  });
  return { id: row.id };
}

/**
 * THE JOB CARD'S SESSIONS, newest first, with the correction chain intact. A corrected session is
 * NOT removed: the original stays visible beside what replaced it, which is the whole point of a
 * correction being a row rather than an edit.
 */
export async function sessionsForCard(db: PrismaClient | Tx, jobCardId: string) {
  return db.jobClockSession.findMany({
    where: { job_card_id: jobCardId },
    orderBy: { started_at: 'desc' },
    select: {
      id: true, user_id: true, started_at: true, ended_at: true,
      started_source: true, ended_source: true, ended_cause: true,
      device_started_at: true, device_ended_at: true, started_received_at: true, ended_received_at: true,
      corrects_id: true, correction_reason: true, corrected_by_user_id: true,
    },
  });
}

/** The tech's open session, if any — what the PWA needs to render the button's state. */
export async function openSessionFor(userId: string) {
  return prisma.jobClockSession.findFirst({
    where: { user_id: userId, ended_at: null },
    select: { id: true, job_card_id: true, started_at: true, started_source: true, device_started_at: true, started_received_at: true },
  });
}
