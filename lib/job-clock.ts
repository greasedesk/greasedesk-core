/**
 * File: lib/job-clock.ts
 * THE RULES for time on a job. Pure, importing nothing — so every one is provable without a
 * database, a phone, or a clock that can be persuaded to lie.
 *
 * NOT A TIMESHEET (owner, 2026-09-12). Time on a JOB, not hours worked: the rep-visit framing, a
 * deliverable rather than supervision. And it moves no money in this slice — see the schema note.
 */

/** How an instant arrived. The RepVisit.source precedent: the row says how the fact got here. */
export const CLOCK_SOURCES = ['live', 'queued', 'correction'] as const;
export type ClockSource = (typeof CLOCK_SOURCES)[number];

/** Why a session ended. 'superseded' = the tech clocked onto another job, which closes this one. */
export const END_CAUSES = ['tech', 'superseded', 'correction'] as const;
export type EndCause = (typeof END_CAUSES)[number];

/**
 * HOW FAR TWO CLOCKS MAY DISAGREE BEFORE THE SESSION IS NOT A DURATION.
 *
 * A phone that is a few minutes out is ordinary. A phone hours out — a dead battery, a wrong
 * timezone, a factory reset — produces a number that looks like work and is not. Such a session
 * renders as DISPUTED rather than as hours (owner, 2026-09-12): the skew stays visible and is never
 * averaged into one reconciled figure.
 *
 * Fifteen minutes is a judgement, not a measurement, and it is the smallest window that does not
 * flag ordinary drift. It is here, named, so it can be argued with.
 */
export const DISPUTE_SKEW_MINUTES = 15;

/**
 * WHAT THE SERVER RECORDS AS THE INSTANT, given what a device claimed.
 *
 * Offline is the case the "server time, never the device's" rule could not answer: with no server
 * there is no server time, and refusing would kill the feature on the forecourt where it is most
 * needed. So the device's claim is accepted AND labelled, the server's receipt is always recorded
 * beside it, and a claim in the FUTURE is clamped — a clock ahead of the server would otherwise
 * produce a session that started after it was reported.
 */
export function resolveInstant(
  claimed: Date | null,
  receivedAt: Date,
): { at: Date; source: ClockSource; device: Date | null; clamped: boolean } {
  if (!claimed) return { at: receivedAt, source: 'live', device: null, clamped: false };
  const clamped = claimed.getTime() > receivedAt.getTime();
  return { at: clamped ? receivedAt : claimed, source: 'queued', device: claimed, clamped };
}

/** Minutes between what the device claimed and when the server heard it. Null when nothing was claimed. */
export function skewMinutes(device: Date | null, receivedAt: Date | null): number | null {
  if (!device || !receivedAt) return null;
  return Math.round(Math.abs(receivedAt.getTime() - device.getTime()) / 60_000);
}

export type ClockRow = {
  started_at: Date; ended_at: Date | null;
  device_started_at: Date | null; device_ended_at: Date | null;
  started_received_at: Date; ended_received_at: Date | null;
};

export type SessionState = 'running' | 'closed' | 'disputed';

/**
 * RUNNING, CLOSED OR DISPUTED — and running is never zero.
 *
 * An open session has no end, which is honest-null: it renders as still running. Reading it as a
 * zero-hour session would be the silent version of the same fact, and a job would look untouched
 * while somebody is under it.
 */
export function sessionState(row: ClockRow, skewLimit = DISPUTE_SKEW_MINUTES): SessionState {
  const worst = Math.max(
    skewMinutes(row.device_started_at, row.started_received_at) ?? 0,
    skewMinutes(row.device_ended_at, row.ended_received_at) ?? 0,
  );
  if (worst > skewLimit) return 'disputed';
  return row.ended_at ? 'closed' : 'running';
}

/** Minutes a CLOSED, undisputed session accounts for. A running or disputed one contributes null. */
export function sessionMinutes(row: ClockRow, skewLimit = DISPUTE_SKEW_MINUTES): number | null {
  if (sessionState(row, skewLimit) !== 'closed' || !row.ended_at) return null;
  return Math.round((row.ended_at.getTime() - row.started_at.getTime()) / 60_000);
}

/**
 * THE TWO NUMBERS A JOB CARD MUST SHOW, and why both.
 *
 * LABOUR is the SUM of sessions: two techs on one car for an hour is two hours of labour, and the
 * cost model needs the sum. ON-THE-RAMP is the elapsed span from the first start to the last end,
 * which is what the diary and the customer experienced. "3 hours of labour" and "90 minutes on the
 * ramp" are both true, and a reader shown one number assumes the wrong one — the ambiguity IS the
 * defect (owner, 2026-09-12), so neither is offered alone.
 */
export function jobTotals(rows: ClockRow[], skewLimit = DISPUTE_SKEW_MINUTES): {
  labourMinutes: number; elapsedMinutes: number | null; running: number; disputed: number; counted: number;
} {
  let labourMinutes = 0, running = 0, disputed = 0, counted = 0;
  let first: number | null = null, last: number | null = null;
  for (const r of rows) {
    const state = sessionState(r, skewLimit);
    if (state === 'running') { running += 1; continue; }
    if (state === 'disputed') { disputed += 1; continue; }
    const mins = sessionMinutes(r, skewLimit);
    if (mins == null) continue;
    labourMinutes += mins; counted += 1;
    const s = r.started_at.getTime(), e = (r.ended_at as Date).getTime();
    first = first === null ? s : Math.min(first, s);
    last = last === null ? e : Math.max(last, e);
  }
  return { labourMinutes, elapsedMinutes: first === null || last === null ? null : Math.round((last - first) / 60_000), running, disputed, counted };
}

/**
 * HAS THIS SESSION RUN PAST THE END OF THE SITE'S WORKING DAY?
 *
 * The trigger for surfacing a forgotten clock-off, and DERIVED rather than invented (owner,
 * 2026-09-12): a fixed hour count would be a number nobody chose. `Site.close_hour` is the diary's
 * own end of day, so "still running after the workshop shut" is a real event rather than a
 * threshold. The site's hours are floating wall-clock, exactly as the diary treats them — no
 * timezone conversion, the same convention as lib/diary-time.
 *
 * It SURFACES, it does not close. Nothing here ends a session: a cron that tidied up would be
 * inventing an end time, which is the thing this whole model refuses to do.
 */
export function ranPastWorkingDay(startedAt: Date, now: Date, closeHour: number): boolean {
  if (now.getTime() <= startedAt.getTime()) return false;
  const endOfDay = new Date(startedAt);
  endOfDay.setHours(closeHour, 0, 0, 0);
  // Started AFTER the workshop shut (a late finish): give it until the next day's close.
  if (startedAt.getTime() >= endOfDay.getTime()) endOfDay.setDate(endOfDay.getDate() + 1);
  return now.getTime() > endOfDay.getTime();
}

/** A correction's reason: real text, bounded. Blank is not a reason. */
export function normaliseCorrectionReason(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 500) return null;
  return s;
}
