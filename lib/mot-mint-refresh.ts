/**
 * File: lib/mot-mint-refresh.ts
 * VERIFY THE MOT EXPIRY AT THE MOMENT IT BECOMES A CLAIM.
 *
 * The invoice's needs block prints the vehicle's MOT expiry, read live at mint and frozen with
 * everything else. Until now nothing refreshed it, so the printed date was only as current as
 * whenever somebody last happened to look — and 210 of TMBS's 214 stored expiries have never been
 * verified at all.
 *
 * LB14FJX is the case: stored 2026-09-20, DVSA 2027-09-20, tested 2026-08-21 at 117,735 miles —
 * which is the odometer-out of the very card that produced the invoice. The garage MOT'd the car
 * and then printed a year-stale expiry on the invoice for that visit.
 *
 * ── IT RUNS BEFORE THE TRANSACTION, NEVER INSIDE IT ─────────────────────────────────────────────
 * issueInvoiceForCard takes a `tx`; the caller opens the transaction. An HTTP call inside that
 * would hold a pooled Neon connection open across somebody else's network, which is how a pgbouncer
 * endpoint runs out of them. So this is called first, writes the vehicle row, and the mint then
 * reads what is there — the freeze needs no change at all.
 *
 * ── A FAILURE IS NOT NEWS ABOUT THE CAR, BUT IT IS NEWS ─────────────────────────────────────────
 * No failure writes a field, stamps mot_checked_at, or stops the mint. The invoice is issued on the
 * stored value, which is exactly what happened before this existed: an MOT lookup must never be the
 * reason a garage cannot bill.
 *
 * What changed is that `answered: false` no longer stands alone. This comment used to say dvsaLookup
 * "answers null for a 404, a 403, a 429, a timeout and an unconfigured credential alike" — true, and
 * the reason the mint audit could not tell a car DVSA has never heard of from a key whose window was
 * spent. The reason now rides along (`reason`), unused by the mint's DECISION and recorded in its
 * outcome, because the decision is right either way and the diagnosis was the thing missing.
 */
import type { PrismaClient } from '@prisma/client';
import { dvsaLookup, motFieldsToWrite, type DvsaFailure, type DvsaResult } from '@/lib/dvsa';

/** Long enough for a healthy DVSA, short enough that a sick one is not felt at the till. */
export const MINT_LOOKUP_TIMEOUT_MS = 3000;

export type MintRefreshOutcome = {
  /** Did we get an answer at all? False for every failure mode, including the timeout. */
  answered: boolean;
  /** WHICH failure, when there was one — null on an answer. Diagnosis, never a decision here. */
  reason: DvsaFailure | null;
  /** Set only when the expiry itself moved — the fact worth an audit row. */
  expiryChanged: null | { from: string | null; to: string };
  /** Every field the write touched, for the audit. Empty when nothing moved. */
  written: string[];
};

/**
 * RACED, NOT CANCELLED. dvsaLookup owns its own fetch and takes no signal, so the timeout abandons
 * the wait rather than the request: the call may still complete into a void, which costs nothing
 * and is the honest description of what this does. Cancelling properly means threading a signal
 * through the lookup, which is a change to a path four other callers share.
 */
async function lookupWithin(reg: string, ms: number, lookup: (r: string) => Promise<DvsaResult>): Promise<DvsaResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // OUR deadline, named as ours. The race losing is a timeout WE imposed at MINT_LOOKUP_TIMEOUT_MS,
  // which is shorter than dvsaLookup's own 5s abort — so this branch, not that one, is what a slow
  // DVSA produces at the till, and it must not be reported as DVSA being unreachable.
  const timedOut: DvsaResult = { ok: false, vehicle: null, reason: 'timeout', status: null };
  try {
    return await Promise.race([
      lookup(reg),
      new Promise<DvsaResult>((resolve) => { timer = setTimeout(() => resolve(timedOut), ms); }),
    ]);
  } catch {
    // A THROWING LOOKUP IS A FAILED LOOKUP. dvsaLookup does not throw; an injected one might, and
    // `unavailable` is the honest reading of a lookup that blew up rather than answered.
    return { ok: false, vehicle: null, reason: 'unavailable', status: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Refresh one vehicle's MOT facts. Returns what happened so the caller can audit it; never throws,
 * because nothing here is worth failing a mint over.
 *
 * `lookup` is injectable so a gate can prove both branches without depending on DVSA being up —
 * a gate that reaches a third-party API is a gate that goes red when somebody else has an outage.
 */
export async function refreshMotForMint(
  db: PrismaClient,
  vehicle: { id: string; registration: string; mot_expiry: Date | null; last_mot_mileage: number | null; last_mot_date: Date | null },
  opts: { lookup?: (r: string) => Promise<DvsaResult>; timeoutMs?: number } = {},
): Promise<MintRefreshOutcome> {
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const before = iso(vehicle.mot_expiry);
  try {
    const r = await lookupWithin(vehicle.registration, opts.timeoutMs ?? MINT_LOOKUP_TIMEOUT_MS, opts.lookup ?? dvsaLookup);
    if (!r.ok) return { answered: false, reason: r.reason, expiryChanged: null, written: [] };
    const data = r.vehicle;

    const write = motFieldsToWrite(
      { mot_expiry: vehicle.mot_expiry, last_mot_mileage: vehicle.last_mot_mileage, last_mot_date: vehicle.last_mot_date },
      data,
    );
    // ANSWERED IS ANSWERED. mot_checked_at is stamped even when nothing moved — "DVSA agrees with
    // what we hold" is exactly the fact the column exists to record, and the commonest one.
    await db.vehicle.update({ where: { id: vehicle.id }, data: { ...write, mot_checked_at: new Date() } });
    const after = write.mot_expiry ? iso(write.mot_expiry) : before;
    return {
      answered: true,
      reason: null,
      expiryChanged: write.mot_expiry ? { from: before, to: after as string } : null,
      written: Object.keys(write),
    };
  } catch {
    // Belt and braces: a write that fails must not take the mint with it either. DVSA answered —
    // the failure was OURS — so this is `unavailable` rather than any verdict about the lookup.
    return { answered: false, reason: 'unavailable', expiryChanged: null, written: [] };
  }
}
