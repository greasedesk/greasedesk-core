/**
 * File: lib/programme-settings.ts
 * THE one place the trial length comes from, and the one place it can be changed.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────────────────────────
 * The trial length used to live in two hard-coded constants — lib/stripe's TRIAL_PERIOD_DAYS and
 * lib/trial's TRIAL_DAYS, both 60 — kept in step by a COMMENT saying one mirrored the other. Change
 * one and a garage gets a Stripe trial of one length and a Group.trial_ends_at of another, with
 * nothing anywhere to notice. Seven more 60s sat in marketing copy, each its own source.
 *
 * It is now a SETTING, on the ProgrammeSettings singleton, editable in the Engine Room. Nothing
 * reads the number any other way: scripts/trial-setting-gate scans pages/, components/ and lib/ for
 * a literal trial length and fails on any hit, which is the clause that keeps this true.
 *
 * ── THE SINGLETON IS UPSERTED, NEVER DEFAULTED IN CODE ─────────────────────────────────────────
 * getProgrammeSettings() creates the row from the SCHEMA's defaults if it is missing, rather than
 * falling back to a number here. A fallback constant would be the second source all over again,
 * only harder to see. `create: { id: 'singleton' }` names no values at all: every default lives in
 * prisma/schema.prisma and nowhere else.
 */
import { prisma as defaultDb } from '@/lib/db';

type Db = any; // a PrismaClient or an interactive-transaction client; both satisfy what is used here

export const SETTINGS_ID = 'singleton';

/**
 * The PUBLIC pages whose copy prints the trial length and which are statically generated. Saving
 * the setting refreshes exactly these. A page added to the marketing site that prints the number
 * must be added here too — nothing else in the system knows the list.
 * /llms.txt and the onboarding checkout page are deliberately ABSENT: both are server-rendered on
 * every request, so they are already correct the instant the setting is saved.
 */
export const PUBLIC_COPY_PATHS = ['/', '/pricing'] as const;

/**
 * NOT NAMED FOR THE TRIAL, on purpose. A bound on what an operator may type is not a trial length
 * anybody is offered, but an identifier containing both "trial" and "days" is exactly what the
 * gate's no-literal scan looks for — and an allow-list exception in that scan is a hole that the
 * next literal slips through. The bound is sanity only: below a day is not a trial, and beyond a
 * year is a typo, not a policy.
 */
const SANE_BOUNDS = { min: 1, max: 365 };

/** Why this value may not be saved, or null when it may. */
export function refuseTrialLength(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) return 'The trial length must be a whole number of days.';
  if (n < SANE_BOUNDS.min) return `A trial of ${n} days is not a trial. The shortest allowed is ${SANE_BOUNDS.min} day.`;
  if (n > SANE_BOUNDS.max) return `A trial of ${n} days is longer than a year. The longest allowed is ${SANE_BOUNDS.max} days.`;
  return null;
}

/** The settings row, created from the schema's defaults if it has never been written. */
export async function getProgrammeSettings(db: Db = defaultDb) {
  return db.programmeSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
}

/** THE trial length. Every surface that prints or seeds a trial reads this. */
export async function trialDays(db: Db = defaultDb): Promise<number> {
  return (await getProgrammeSettings(db)).trial_days;
}

/**
 * The trial end date for a signup happening NOW. Stripe owns the clock once a subscription exists
 * (lib/stripe-billing-cache mirrors trial_end back onto Group.trial_ends_at); this seeds the date
 * for a garage that has not reached Checkout yet.
 */
export async function trialEndsAt(db: Db = defaultDb): Promise<Date> {
  return new Date(Date.now() + (await trialDays(db)) * 24 * 60 * 60 * 1000);
}

export type SaveTrialResult = {
  days: number;
  /** The public paths successfully refreshed. */
  revalidated: string[];
  /** Null when every refresh succeeded. Set means THE LIVE SITE MAY STILL SHOW THE OLD NUMBER. */
  revalidateError: string | null;
};

/**
 * Change the trial length. THE write chokepoint: validation, the audit row and the refresh of the
 * public copy are all here, so no caller can do one without the others.
 *
 * ── NOBODY ALREADY ON A TRIAL MOVES ────────────────────────────────────────────────────────────
 * This writes ONE integer. Group.trial_ends_at is a date stamped at signup and is not touched,
 * recomputed or re-derived here — a garage keeps the trial it was given, which is also what it was
 * told in writing. Lengthening the setting is an offer to the NEXT garage, never a gift to the
 * current ones; shortening it never shortens anybody's live trial.
 *
 * `revalidate` is passed in rather than imported because it belongs to a NextApiResponse. The gate
 * passes its own, which is the only reason this is a parameter.
 *
 * `actorId` may be null only for the gate; every route through the Engine Room carries an operator,
 * and an unaudited change to what every new garage is offered is not a thing this should allow.
 */
export async function saveTrialDays(
  db: Db,
  opts: { days: number; actorId: string | null; revalidate: (path: string) => Promise<unknown> },
): Promise<SaveTrialResult> {
  const refusal = refuseTrialLength(opts.days);
  if (refusal) throw new Error(refusal);

  const before = await getProgrammeSettings(db);
  await db.programmeSettings.update({ where: { id: SETTINGS_ID }, data: { trial_days: opts.days } });

  if (opts.actorId) {
    await db.superAdminAudit.create({
      data: {
        operator_user_id: opts.actorId,
        action: 'programme_trial_days',
        target_group_id: null,
        target_operator_id: null,
        target_name_snapshot: 'Trial length',
        target_ref_snapshot: `${before.trial_days} → ${opts.days} days`,
        detail: { from: before.trial_days, to: opts.days },
      },
    });
  }

  // ── "SAVED" AND "THE PUBLIC SITE AGREES" ARE DIFFERENT QUESTIONS ─────────────────────────────
  // The marketing pages are statically generated. A save that succeeds while the refresh fails
  // leaves the Engine Room showing 30 and greasedesk.com promising 60, and that is the one outcome
  // nobody would notice. So the result is recorded on the row and REPORTED to the caller; the
  // screen prints it. The pages also carry a time-based `revalidate`, so a failure here self-heals
  // within the hour rather than standing until somebody saves again.
  const revalidated: string[] = [];
  let revalidateError: string | null = null;
  for (const p of PUBLIC_COPY_PATHS) {
    try { await opts.revalidate(p); revalidated.push(p); }
    catch (e: any) { revalidateError = `${p}: ${String(e?.message ?? e)}`.slice(0, 300); }
  }
  await db.programmeSettings.update({
    where: { id: SETTINGS_ID },
    data: revalidateError
      ? { copy_revalidate_error: revalidateError }
      : { copy_revalidated_at: new Date(), copy_revalidate_error: null },
  });

  return { days: opts.days, revalidated, revalidateError };
}
