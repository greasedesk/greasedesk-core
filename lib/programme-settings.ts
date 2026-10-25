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
import { COMPANY } from '@/lib/company-info';
// @ts-ignore — JS config (no type declarations); the shape is ASSERTED on the next line rather
// than assumed, so the compiler keeps checking every use of it below.
// WITH THE .js EXTENSION, unlike lib/gssp-i18n's copy of this import. That one is only ever loaded
// by webpack, which fills in extensions; this module is also imported by the gate through Node's
// ESM loader, which does not, and an extensionless specifier is ERR_MODULE_NOT_FOUND there.
import nextI18NextConfigRaw from '../next-i18next.config.js';

const I18N = (nextI18NextConfigRaw as { i18n: { locales: string[]; defaultLocale: string } }).i18n;

type Db = any; // a PrismaClient or an interactive-transaction client; both satisfy what is used here

export const SETTINGS_ID = 'singleton';

/**
 * The PUBLIC pages whose copy prints the trial length and which are statically generated. A page
 * added to the marketing site that prints the number must be added here too — nothing else in the
 * system knows the list. The onboarding checkout page and /llms.txt are deliberately ABSENT: both
 * are server-rendered on every request, so they are correct the instant the setting is saved.
 */
export const PUBLIC_COPY_PAGES = ['/', '/pricing'] as const;

/**
 * THE PATHS `res.revalidate()` IS GIVEN — locale-prefixed, derived from the i18n config.
 *
 * ── WHY THIS IS NOT ['/', '/pricing'] ──────────────────────────────────────────────────────────
 * It was, and a save on 2026-10-25 reported "the public pages were refreshed" while greasedesk.com
 * kept promising the old number for an hour. The site runs Next i18n (en-GB only), so the
 * PRERENDERED ROUTE KEYS carry the locale: production answers `x-matched-path: /en-GB`, not `/`.
 * Revalidating `/` addresses a page that is not the one in the cache.
 *
 * DERIVED, not written out: hard-coding '/en-GB' would be a second copy of the locale list, which
 * is the same defect as the two hard-coded trial lengths this module exists to remove. Add a
 * locale to next-i18next.config and its pages join this list with no change here.
 */
export const revalidationTargets = (): string[] => {
  return I18N.locales.flatMap((l: string) => PUBLIC_COPY_PAGES.map((p) => (p === '/' ? `/${l}` : `/${l}${p}`)));
};

/** The URLs a VISITOR actually types — what verification reads back. */
export const publicCopyUrls = (origin: string): string[] =>
  PUBLIC_COPY_PAGES.map((p) => `${origin.replace(/\/+$/, '')}${p === '/' ? '/' : p}`);

/** The apex. Verification must read the PUBLIC site, never whichever host the save came in on. */
export const publicOrigin = (): string => COMPANY.siteUrl;

/**
 * The trial length a rendered page is actually showing, or null when the page names none or names
 * more than one. Scripts and HTML comments are stripped first: `__NEXT_DATA__` carries the props
 * as JSON and React's SSR markers split "30" away from "-day", so a naive grep of the raw HTML
 * answers a different question from the one a reader is asking.
 */
export function renderedTrialDays(html: string): number | null {
  // COMMENTS GO TO NOTHING, TAGS GO TO A SPACE, and the difference is the whole function. React's
  // server renderer splits an interpolated value out of its text run — `your <!-- -->45<!-- -->-day
  // free trial` — so replacing a comment with a SPACE yields "45 -day", which matches no pattern a
  // reader would write. The first version did exactly that and reported "no number" about a page
  // plainly showing one. Tags still become spaces: they really do separate words.
  const noScript = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, '');
  const text = noScript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const found = [...new Set([...text.matchAll(/(\d{1,3})[- ]day/g)].map((m) => Number(m[1])))];
  return found.length === 1 ? found[0] : null;
}

export type CopyCheck = { url: string; shows: number | null; agrees: boolean };

/**
 * WHAT THE PUBLIC SITE IS ACTUALLY SHOWING. This is the whole point of the rewrite: `res.revalidate`
 * resolving is not evidence that anything changed, and on 2026-10-25 it resolved for both pages
 * while neither moved. The only honest answer to "did the refresh work" is to go and read the page.
 */
export async function readPublicCopy(origin: string, want: number): Promise<CopyCheck[]> {
  return Promise.all(publicCopyUrls(origin).map(async (url) => {
    try {
      // BOUNDED. This runs inside the operator's own request, and an unbounded fetch to another
      // host is a hang waiting to happen — a slow read must become "not confirmed", never a
      // spinner that never resolves.
      const r = await fetch(url, {
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal: AbortSignal.timeout(4000),
      });
      const shows = renderedTrialDays(await r.text());
      return { url, shows, agrees: shows === want };
    } catch {
      return { url, shows: null, agrees: false };
    }
  }));
}

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

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type SaveTrialResult = {
  days: number;
  /** The paths res.revalidate() was given. ATTEMPTED — not evidence that anything changed. */
  attempted: string[];
  /** A throw from res.revalidate(). Null does NOT mean the page changed; see `verified`. */
  revalidateError: string | null;
  /** THE ONLY THING THAT MEANS THE PUBLIC SITE AGREES: it was read back and it shows this number. */
  verified: boolean;
  /** What each public URL was actually showing when it was read back. */
  checks: CopyCheck[];
  /** Why it is not verified, when it is not. Null when verified. */
  note: string | null;
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
  opts: {
    days: number;
    actorId: string | null;
    revalidate: (path: string) => Promise<unknown>;
    /** The origin to READ BACK. The apex in production; the gate and dev pass their own. */
    origin?: string;
  },
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

  // ── ASK THE PAGE, DO NOT ASK THE REFRESHER ──────────────────────────────────────────────────
  // THE DEFECT THIS REPLACES. The first version recorded success when res.revalidate() did not
  // throw, and reported "the public pages were refreshed". On 2026-10-25 it resolved for both
  // pages, wrote copy_revalidated_at, told the owner it was done — and greasedesk.com went on
  // promising the old number for an hour. res.revalidate() resolving is not evidence of anything:
  // with `experimental.trustHostHeader` unset it takes Next's INTERNAL branch
  // (api-utils/node/api-resolver.js:217), which has no status check in it at all.
  //
  // So the refresh is ATTEMPTED and then the public pages are READ BACK. Only a page that actually
  // shows the new number counts. Three outcomes, never two:
  //    verified            — the apex was read and shows this number
  //    revalidateError set — the attempt threw
  //    note set            — the attempt resolved and the page still does not agree. The dangerous
  //                          one, and the one that used to be indistinguishable from success.
  const attempted: string[] = [];
  let revalidateError: string | null = null;
  for (const p of revalidationTargets()) {
    try { await opts.revalidate(p); attempted.push(p); }
    catch (e: any) { revalidateError = `${p}: ${describe(e)}`.slice(0, 300); }
  }

  // A regenerated page does not reach every edge the same millisecond, so one disagreeing read is
  // not yet a failure. Two tries, briefly apart — deliberately short, because this runs inside the
  // operator's request. An unconfirmed result is reported as unconfirmed, not retried into silence;
  // the screen re-reads on every load, and the pages' own `revalidate` is the backstop.
  let checks = await readPublicCopy(opts.origin ?? publicOrigin(), opts.days);
  if (!checks.every((c) => c.agrees)) {
    await new Promise((r) => setTimeout(r, 2000));
    checks = await readPublicCopy(opts.origin ?? publicOrigin(), opts.days);
  }
  const verified = checks.length > 0 && checks.every((c) => c.agrees);
  const note = verified ? null
    : revalidateError ? null
    : `the refresh was accepted but ${checks.filter((c) => !c.agrees).map((c) => `${c.url} still shows ${c.shows ?? 'no number'}`).join('; ')}`.slice(0, 300);

  await db.programmeSettings.update({
    where: { id: SETTINGS_ID },
    data: verified
      ? { copy_revalidated_at: new Date(), copy_revalidate_error: null }
      : { copy_revalidate_error: (revalidateError ?? note ?? 'not confirmed').slice(0, 300) },
  });

  return { days: opts.days, attempted, revalidateError, verified, checks, note };
}
