/**
 * File: lib/rep-pay-run.ts
 * SALES COMMISSION: RELEASED BY A PERSON, INTO A RUN A PERSON CLOSES.
 *
 * ── LANGUAGE ────────────────────────────────────────────────────────────────────────────────────
 * Sales Commission. A rep is self-employed and invoices us for it — never a wage, never a salary,
 * and never "pay" as a noun for the rep. That is a fact about their legal status before it is a
 * choice of words on a screen, which is why `payout_id` was renamed `pay_run_id` rather than left.
 *
 * ── NOTHING PAYS ITSELF ─────────────────────────────────────────────────────────────────────────
 * Every line starts `pending` and stays there indefinitely. An area manager releases it or holds
 * it; a run's scheduled date makes it ELIGIBLE to close and never closes it. "What we owe" and
 * "what we have approved" are two questions and this file keeps them two.
 *
 * ── THE FOURTEEN-DAY RULE IS REPORTED, NOT ENFORCED ─────────────────────────────────────────────
 * windowVerdict returns pass / fail / unknown WITH the dates that decided it, and nothing here acts
 * on it. A failing line is releasable; releasing it costs an override reason recorded against the
 * line. That is the whole design: the rule informs a person, the person decides, and the decision
 * is what gets written down.
 *
 * ── CONCURRENCY, AND THE DEFECT NOT TO REINTRODUCE ──────────────────────────────────────────────
 * releaseEntry is a CONDITIONAL UPDATE matching on the pre-state — `status IN (pending, held) AND
 * pay_run_id IS NULL` — reading the affected-row count. NOT a unique index plus a caught P2002:
 * lib/commission's header records that a caught P2002 still poisons its transaction, because
 * Postgres aborts the block and every later statement dies 25P02. There is no P2002 in this file
 * and there must never be one. The run row is taken FOR UPDATE first, the InvoiceSequence row-lock
 * precedent, so a release and a close cannot interleave.
 */
import type { PrismaClient, Prisma } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;
type RootDb = Db & { $transaction: unknown };

export const PAY_RUN_STATUSES = ['open', 'closed'] as const;
export type PayRunStatus = (typeof PAY_RUN_STATUSES)[number];

/** `void` is terminal from ANY state, including released — see the release CHECK in the migration. */
export const ENTRY_STATUSES = ['pending', 'held', 'released', 'billed', 'paid', 'void'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** Why a manager held a line. Codes, never sentences — the sentence goes in CommissionEntryNote. */
export const HOLD_REASONS = [
  'no_visit_recorded',
  'outside_visit_window',
  'evidence_queried',
  'awaiting_rep_response',
] as const;

/**
 * Why a manager released a line the rule did not support.
 *
 * NO `other`, for the reason UNSCANNED_REASONS has none: the prose that would explain one lives in
 * a note row, and a set that cannot express a real case is WRONG rather than quietly extended.
 * Amending it is a migration, which is a decision somebody makes on purpose.
 */
export const RELEASE_OVERRIDE_REASONS = [
  'visit_confirmed_offline',
  'system_prevented_the_scan',
  'garage_onboarding_month',
] as const;

export type Refusal = { code: string; message: string };
const blank = (s: string | null | undefined) => !s || s.trim() === '';
const oneOf = (set: readonly string[], v: unknown) => typeof v === 'string' && set.includes(v);

/** Days that must pass between visits that count — the same figure lib/rep-visit enforces. */
export const VISIT_MIN_DAYS = 14;

export type WindowVerdict = {
  /** TRUE pass, FALSE fail, NULL "nothing to judge" — an absent visit is not a failing one. */
  pass: boolean | null;
  period: string;
  visitAt: Date | null;
  previousVisitAt: Date | null;
  daysSince: number | null;
};

/**
 * What the fourteen-day rule says about this line, WITH THE DATES THAT DECIDED IT.
 *
 * A verdict with no dates is an assertion the manager cannot check, and this screen exists so that
 * they can. `pass: null` is the honest answer when there is no visit: the rule has nothing to
 * judge, and rendering that as a failure would invent evidence against the rep.
 */
export function windowVerdict(args: {
  period: string;
  visitAt: Date | null;
  previousVisitAt: Date | null;
}): WindowVerdict {
  const { period, visitAt, previousVisitAt } = args;
  if (!visitAt) return { pass: null, period, visitAt: null, previousVisitAt, daysSince: null };
  if (!previousVisitAt) return { pass: true, period, visitAt, previousVisitAt: null, daysSince: null };
  const daysSince = Math.floor((visitAt.getTime() - previousVisitAt.getTime()) / 86_400_000);
  return { pass: daysSince >= VISIT_MIN_DAYS, period, visitAt, previousVisitAt, daysSince };
}

/** A line released in a run for a LATER period is arrears. Derived on every read, never stored. */
export function isArrears(entryPeriod: string, runPeriod: string): boolean {
  return entryPeriod < runPeriod;
}

export type LineState = {
  status: EntryStatus | string;
  payRunId: string | null;
  /** windowVerdict.pass — TRUE, FALSE, or NULL when there was nothing to judge. */
  windowPass: boolean | null;
  /** Whether a visit matched this entry at all, on (garage, party, period). */
  hasVisit: boolean;
};

const alreadyReleased = (l: LineState): Refusal | null =>
  l.payRunId !== null || !['pending', 'held'].includes(l.status)
    ? { code: 'already_released', message: 'This line has already been released into a run.' }
    : null;

/**
 * May this line be released, and on what terms?
 *
 * An override is REQUIRED when the rule did not support the release — a failing window, or no
 * matching visit at all — and REFUSED when it did. A reason recorded against every line is a reason
 * recorded against none: the point of the override is that a reader can see which decisions needed
 * one.
 */
export function refuseRelease(line: LineState, args: { overrideReason?: string | null }): Refusal | null {
  const done = alreadyReleased(line);
  if (done) return done;
  const needsOverride = line.windowPass === false || !line.hasVisit;
  const given = !blank(args.overrideReason);
  if (needsOverride && !given) {
    return { code: 'override_required', message: 'Say why this line is being released without a visit that meets the rule.' };
  }
  if (!needsOverride && given) {
    return { code: 'override_not_needed', message: 'This line meets the rule; an override reason would make the record misleading.' };
  }
  if (given && !oneOf(RELEASE_OVERRIDE_REASONS, args.overrideReason)) {
    return { code: 'bad_reason', message: 'That is not one of the reasons this form offers.' };
  }
  return null;
}

/** May this line be held, and does it carry a reason from the set? */
export function refuseHold(line: LineState, args: { holdReason?: string | null }): Refusal | null {
  const done = alreadyReleased(line);
  if (done) return done;
  if (blank(args.holdReason)) return { code: 'hold_reason_required', message: 'Say why this line is being held.' };
  if (!oneOf(HOLD_REASONS, args.holdReason)) return { code: 'bad_reason', message: 'That is not one of the reasons this form offers.' };
  return null;
}

/**
 * THE ONE PREDICATE. lib/invoice::canEditInvoice's shape, and for the same reason: many callers,
 * one rule, and no caller re-deriving "closed" for itself. A second copy is how a closed run gets
 * edited by the one path that forgot.
 */
export function canEditPayRun(run: { status: string }): boolean {
  return run.status === 'open';
}

/** The refusal every writer asks — a new line, a removed line, an amount change, all the same rule. */
export function refuseRunChange(run: { status: string }): Refusal | null {
  return canEditPayRun(run) ? null
    : { code: 'run_closed', message: 'This run is closed. Release the line into the run that is open now.' };
}

/**
 * ELIGIBILITY IS A PROMPT, NOT A PERMISSION. The scheduled date says a run is ready to be looked
 * at; a manager who has finished early may close before it, and a run that passes it does not close
 * itself. Reported on the screen, acted on by nobody.
 */
export function runEligibleToClose(run: { scheduled_on: Date }, now: Date): boolean {
  return now.getTime() >= run.scheduled_on.getTime();
}

/** Closing needs an open run and words. The date is deliberately not consulted. */
export function refuseClose(run: { status: string }, args: { signoff?: string | null; now: Date }): Refusal | null {
  const shut = refuseRunChange(run);
  if (shut) return shut;
  if (blank(args.signoff)) {
    return { code: 'signoff_required', message: 'Sign off what you checked before closing this run.' };
  }
  return null;
}

// ── THE WRITES ────────────────────────────────────────────────────────────────────────────────
export type WriteResult = { ok: true } | { ok: false; code: string };

/**
 * Release one line into one run.
 *
 * The run row is taken FOR UPDATE so a concurrent close cannot slip between the check and the
 * write. The line itself moves by a CONDITIONAL UPDATE on its pre-state, and the affected-row count
 * is the answer: two managers pressing at once produce exactly one release and one
 * `already_released`. No unique index, no caught P2002 — see the header.
 */
export async function releaseEntry(db: RootDb, args: {
  entryId: string;
  runId: string;
  operatorId: string;
  shownAsVisited: boolean;
  overrideReason?: string | null;
}): Promise<WriteResult> {
  return (db as any).$transaction(async (tx: any) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "RepPayRun" WHERE "id" = ${args.runId} FOR UPDATE`;
    const run = rows[0];
    if (!run) return { ok: false as const, code: 'no_run' };
    const shut = refuseRunChange(run);
    if (shut) return { ok: false as const, code: shut.code };

    const res = await tx.commissionEntry.updateMany({
      where: { id: args.entryId, status: { in: ['pending', 'held'] }, pay_run_id: null },
      data: {
        status: 'released',
        pay_run_id: args.runId,
        released_at: new Date(),
        released_by: args.operatorId,
        shown_as_visited: args.shownAsVisited,
        release_override_reason: args.overrideReason ?? null,
        held_reason: null,
      },
    });
    return res.count === 1 ? { ok: true as const } : { ok: false as const, code: 'already_released' };
  });
}

/** Hold a line. Same conditional-update shape, so a hold cannot race a release into both states. */
export async function holdEntry(db: Db, args: {
  entryId: string;
  operatorId: string;
  holdReason: string;
}): Promise<WriteResult> {
  if (!oneOf(HOLD_REASONS, args.holdReason)) return { ok: false, code: 'bad_reason' };
  const res = await (db as any).commissionEntry.updateMany({
    where: { id: args.entryId, status: { in: ['pending', 'held'] }, pay_run_id: null },
    data: { status: 'held', held_reason: args.holdReason },
  });
  return res.count === 1 ? { ok: true } : { ok: false, code: 'already_released' };
}

/**
 * Close a run: freeze the totals and record who signed it off.
 *
 * The totals are SNAPSHOT rather than recomputed on read, because a figure that is recalculated is
 * a figure that can move — and the whole point of closing is that it cannot. Same FOR UPDATE lock,
 * so a release cannot land after the count and before the status changes.
 */
export async function closeRun(db: RootDb, args: {
  runId: string;
  operatorId: string;
  signoff: string;
  now?: Date;
}): Promise<WriteResult> {
  return (db as any).$transaction(async (tx: any) => {
    const rows = await tx.$queryRaw<Array<{ status: string; scheduled_on: Date }>>`
      SELECT "status", "scheduled_on" FROM "RepPayRun" WHERE "id" = ${args.runId} FOR UPDATE`;
    const run = rows[0];
    if (!run) return { ok: false as const, code: 'no_run' };
    const no = refuseClose(run, { signoff: args.signoff, now: args.now ?? new Date() });
    if (no) return { ok: false as const, code: no.code };

    const lines = await tx.commissionEntry.findMany({
      where: { pay_run_id: args.runId },
      select: { party_type: true, party_id: true, amount_pennies: true },
    });
    const parties = new Set(lines.map((l: any) => `${l.party_type}:${l.party_id}`)).size;
    const amount = lines.reduce((a: number, l: any) => a + l.amount_pennies, 0);

    await tx.repPayRun.update({
      where: { id: args.runId },
      data: {
        status: 'closed',
        closed_at: new Date(),
        closed_by: args.operatorId,
        signoff: args.signoff,
        snapshot_parties: parties,
        snapshot_line_count: lines.length,
        snapshot_amount_pennies: amount,
      },
    });
    return { ok: true as const };
  });
}
