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
import { getProfile, DEFAULT_COUNTRY } from '@/lib/locale-profiles';
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
/** The same three fields for a figure that is a STRING — the yearly price as the page prints it. */
export type CopyCheckText = { url: string; shows: string | null; agrees: boolean };

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
 * THE YEARLY PRICE A RENDERED PAGE IS ACTUALLY SHOWING, or null when it names none or more than
 * one. The plan-settings analogue of renderedTrialDays, and it strips scripts for the same
 * reason: `__NEXT_DATA__` carries BOTH figure sets as JSON — including the referral one, which is
 * never server-rendered — so a grep of the raw HTML would find figures no visitor can see.
 *
 * A SAVING IS NOT A PRICE, and both end in "a year". /pricing prints "Billed £750 a year, per
 * site." beside "Save £150 a year · Save 17%", so a naive /£X a year/ finds TWO figures, answers
 * null, and the save reports "the page shows no yearly price" about a page plainly showing one —
 * which reads as a failed refresh and sends somebody hunting the wrong defect. The lookbehind
 * excludes the saving BY NAME rather than by position, so a reordered panel does not break it.
 *
 * WHY THE YEARLY FIGURE AND NOT THE MONTHLY ONE. It is the one string both public pages state in
 * so many words ("Billed £750 a year, per site." and "or £750 a year"), it moves whenever any of
 * the three plan settings that feed it moves, and it is the figure that did not exist on either
 * page before today. The monthly headline on /pricing is a monthly EQUIVALENT of it, so a page
 * showing the right yearly figure and the wrong equivalent is an arithmetic fault in one shared
 * resolver rather than a stale cache — a different failure, with its own clauses.
 */
export function renderedYearlyPrice(html: string): string | null {
  const noScript = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, '');
  const text = noScript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const found = [...new Set([...text.matchAll(/(?<!Save\s)(£[\d,]+(?:\.\d{2})?) a year/g)].map((m) => m[1]))];
  return found.length === 1 ? found[0] : null;
}

/** As readPublicCopy, for the yearly price. Same two pages, same bounded fetch, same three states. */
export async function readPublicPlanCopy(origin: string, want: string): Promise<CopyCheckText[]> {
  return Promise.all(publicCopyUrls(origin).map(async (url) => {
    try {
      const r = await fetch(url, {
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal: AbortSignal.timeout(4000),
      });
      const shows = renderedYearlyPrice(await r.text());
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

/**
 * ── A SETTINGS ID, AND WHO MAY NAME ONE ────────────────────────────────────────────────────────
 * The row is a singleton in production and nothing there ever names a different one. The option
 * exists so a GATE can own its own row and sweep it, instead of writing the live settings on the
 * shared production database — which is how a gate's own value for the trial length reached the
 * public site as a real offer on 2026-10-25.
 *
 * THE CONDITION (owner, 2026-10-25): no production code path accepts a settings id from request
 * input; only gates pass one. It is enforced by a scan, not by a promise — billing-plans-gate
 * fails if the token `settingsId` appears anywhere under pages/. That is why the id lives in an
 * options object with a distinctive name rather than as a bare second argument: a bare string is
 * invisible to a scan, and an invariant nothing can check is a comment.
 */
export type SettingsOpts = { settingsId?: string };
const idOf = (o?: SettingsOpts) => o?.settingsId ?? SETTINGS_ID;

/** The settings row, created from the schema's defaults if it has never been written. */
export async function getProgrammeSettings(db: Db = defaultDb, opts?: SettingsOpts) {
  const id = idOf(opts);
  return db.programmeSettings.upsert({ where: { id }, update: {}, create: { id } });
}

/** THE trial length. Every surface that prints or seeds a trial reads this. */
export async function trialDays(db: Db = defaultDb, opts?: SettingsOpts): Promise<number> {
  return (await getProgrammeSettings(db, opts)).trial_days;
}

/**
 * The trial end date for a signup happening NOW. Stripe owns the clock once a subscription exists
 * (lib/stripe-billing-cache mirrors trial_end back onto Group.trial_ends_at); this seeds the date
 * for a garage that has not reached Checkout yet.
 */
export async function trialEndsAt(db: Db = defaultDb, opts?: SettingsOpts): Promise<Date> {
  return new Date(Date.now() + (await trialDays(db, opts)) * 24 * 60 * 60 * 1000);
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * ── THE PLAN AND REWARD SETTINGS, AND WHY THEY ARE NOT LIKE THE TRIAL LENGTH ───────────────────
 * The trial length is printed on the public site, so saving it must also refresh statically
 * generated pages and prove they changed. None of these is on a STATICALLY GENERATED page — the
 * readers under pages/ are the owner-only Engine Room API and, for the joining switch, the
 * server-rendered affiliate signup pages — so there is nothing to revalidate, and a revalidate
 * call here would be ceremony that looks like a guarantee.
 *
 * THAT IS A PROPERTY OF THOSE PAGES, NOT OF THESE FIELDS (owner, 2026-10-30).
 * affiliate_joining_open governs a public page and is deliberately absent from PUBLIC_COPY_PATHS,
 * because affiliates.greasedesk.com is server-rendered with no ISR so that closing the switch
 * closes signups at once. If that page is ever made static, this field joins PUBLIC_COPY_PATHS and
 * takes the revalidate-and-read-back the trial length has — otherwise a closed programme would go
 * on accepting people from a cached page.
 *
 * Said rather than inferred: if one of these reaches STATIC public copy, it joins
 * PUBLIC_COPY_PATHS and this comment stops being true.
 */
export const PLAN_SETTING_FIELDS = [
  'new_annual_months_paid',
  'renewal_annual_months_paid',
  'offer_months_paid',
  'months_given',
  'total_reward_pennies',
  'instalment_pennies',
  'affiliate_signups_open',
  'affiliate_joining_open',
] as const;
export type PlanSettingField = typeof PLAN_SETTING_FIELDS[number];

/** Which fields are a count of months, and which are money. Drives validation AND the labels. */
export const PLAN_SETTING_KIND: Record<PlanSettingField, 'months' | 'pennies' | 'switch'> = {
  new_annual_months_paid: 'months',
  renewal_annual_months_paid: 'months',
  offer_months_paid: 'months',
  months_given: 'months',
  total_reward_pennies: 'pennies',
  instalment_pennies: 'pennies',
  affiliate_signups_open: 'switch',
  affiliate_joining_open: 'switch',
};

export const PLAN_SETTING_LABEL: Record<PlanSettingField, string> = {
  new_annual_months_paid: 'First annual year for a new garage — months charged',
  renewal_annual_months_paid: 'Annual, renewal — months charged',
  offer_months_paid: 'Affiliate offer — months charged',
  months_given: 'Months of service given on any annual plan',
  total_reward_pennies: 'Affiliate reward per referred garage (total)',
  instalment_pennies: 'Affiliate reward per paid month (monthly plans)',
  // TWO SWITCHES, TWO SUBJECTS, AND THE SCREEN RENDERS FROM THIS MAP — so these labels are the
  // whole defence against turning the wrong one off. The owner's own words, and sharing no
  // distinguishing term: one is about GARAGES getting the offer, the other about PEOPLE joining.
  affiliate_signups_open: 'Referred garages get the offer (12 months for the price of 8)',
  affiliate_joining_open: 'New affiliates can join (public signup at affiliates.greasedesk.com)',
};

/** Why this value may not be saved to this field, or null when it may. */
export function refusePlanSetting(field: PlanSettingField, v: unknown): string | null {
  const label = PLAN_SETTING_LABEL[field];
  if (PLAN_SETTING_KIND[field] === 'switch') {
    return typeof v === 'boolean' ? null : `${label}: must be on or off.`;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) return `${label}: must be a whole number.`;
  if (PLAN_SETTING_KIND[field] === 'months') {
    // 1 to 12. Zero months charged is a plan given away; more than twelve is not an annual plan.
    if (n < 1 || n > 12) return `${label}: must be between 1 and 12 months (got ${n}).`;
    return null;
  }
  // Money, in whole pennies. ZERO IS ALLOWED and is a real setting: a programme that pays no
  // reward is a programme that is off, which is different from a negative one, which is nonsense.
  if (n < 0) return `${label}: must be zero or more pennies (got ${n}).`;
  return null;
}

/**
 * ── THE RULES THAT ARE ABOUT TWO FIELDS AT ONCE ────────────────────────────────────────────────
 * Checked over the RESULTING state, not over the change. A save that touches only months_given
 * can invalidate an offer value that was set months ago and never moved, so asking "is this one
 * value sensible" cannot answer it — the question is whether the settings AFTER this save hold
 * together.
 *
 * Months charged may not exceed months given: charging for eleven and giving ten is worse than
 * monthly and nobody means it. An instalment may not exceed the total reward: the cap would be
 * reached by the first payment, which is a single payment wearing the word instalment.
 */
export function refusePlanCombination(after: Record<string, number | boolean>): string | null {
  const given = Number(after.months_given);
  for (const f of ['new_annual_months_paid', 'renewal_annual_months_paid', 'offer_months_paid'] as const) {
    const paid = Number(after[f]);
    if (Number.isFinite(paid) && Number.isFinite(given) && paid > given) {
      return `${PLAN_SETTING_LABEL[f]} (${paid}) cannot be more than ${PLAN_SETTING_LABEL.months_given.toLowerCase()} (${given}).`;
    }
  }
  const inst = Number(after.instalment_pennies), total = Number(after.total_reward_pennies);
  if (Number.isFinite(inst) && Number.isFinite(total) && inst > total) {
    return `${PLAN_SETTING_LABEL.instalment_pennies} (${inst}p) cannot be more than ${PLAN_SETTING_LABEL.total_reward_pennies.toLowerCase()} (${total}p).`;
  }
  return null;
}

export type SavePlanSettingsResult = {
  /** field → { from, to }, only for fields that actually moved. */
  changed: Partial<Record<PlanSettingField, { from: number | boolean; to: number | boolean }>>;
  /** The row AS READ BACK after the write — not what was sent. */
  after: Record<PlanSettingField, number | boolean>;
  /** The paths res.revalidate() was given. ATTEMPTED — not evidence that anything changed. */
  attempted: string[];
  /** A throw from res.revalidate(). Null does NOT mean the page changed; see `verified`. */
  revalidateError: string | null;
  /** THE ONLY THING THAT MEANS THE PUBLIC SITE AGREES: it was read back and shows this price. */
  verified: boolean;
  /** What each public URL was actually showing when it was read back. */
  checks: CopyCheckText[];
  /** Why it is not verified, when it is not. Null when verified, and null when nothing changed. */
  note: string | null;
};

/**
 * THE YEARLY PRICE AS A PAGE PRINTS IT. One expression, used by the read-back above.
 *
 * DELIBERATELY AN INDEPENDENT ROUTE to the same number: the page gets there through
 * publicPlanChoice, and a read-back that called the page's own resolver would agree with it
 * however wrong both were ([[independent-oracle-finds-copies]] in long form).
 *
 * THE TWO HALVES COME FROM DIFFERENT PLACES, and that is worth knowing before anybody edits this.
 * The MONTHS are an Engine Room setting on this row. The MONTHLY PRICE is not a setting at all —
 * it lives on the country profile in lib/locale-profiles (GB £75) and changing it needs a deploy.
 * So the yearly price an operator can move is `months × a constant`, and this function reads the
 * constant from the profile rather than from a column, because there is no column.
 *
 * It must NOT import lib/billing-plans to get there: billing-plans imports this module, and the
 * cycle would be a real one. lib/locale-profiles is a leaf and is the same source planSettings
 * uses one layer up.
 */
export function yearlyPriceLabelFor(s: { renewal_annual_months_paid: number }, country?: string | null): string {
  const monthlyPennies = Math.round(getProfile(country ?? DEFAULT_COUNTRY).monthlyPrice * 100);
  const pennies = s.renewal_annual_months_paid * monthlyPennies;
  return `£${(pennies / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

/**
 * Change the plan and reward settings. THE write chokepoint: validation, the audit row and the
 * read-back happen together, so no caller can do one without the others.
 *
 * ── IT READS BACK ──────────────────────────────────────────────────────────────────────────────
 * `after` is a fresh read, not the values that were sent. A save that reports what it intended is
 * the shape that told the owner "the public pages were refreshed" on 2026-10-25 while nothing had
 * changed. What the screen prints is what the database holds.
 *
 * ── A CHANGE APPLIES TO NEW SIGNUPS ONLY ───────────────────────────────────────────────────────
 * Nothing here touches TenantAffiliateTerms or TenantPlanTerms. A referred garage's terms are
 * COPIED at signup precisely so an operator may change these tomorrow without moving them. The
 * screen says so, because a settings form that does not is a form somebody will use to try to
 * reprice an existing garage.
 */
/**
 * ── AND NOW THESE NUMBERS ARE ON THE PUBLIC SITE (owner, 2026-10-29) ───────────────────────────
 * Until today no plan setting appeared on a public page, so this function wrote the row, audited
 * it, and stopped — correctly. `/pricing` and the home page now state the yearly price and the
 * saving, both derived from these settings, and both are ISR-cached. So this inherits the trial
 * length's machinery in full: attempt the refresh, then READ THE PAGE BACK, because
 * res.revalidate() resolving is not evidence of anything (it resolved for both pages on
 * 2026-10-25 while greasedesk.com kept the old number for an hour).
 *
 * `/llms.txt` is NOT in the list and must not be: it is server-rendered, so it has no cache to
 * invalidate and already answers from the settings on the next request. Handing res.revalidate()
 * a path that was never prerendered throws, and the save would report a failure that is not one.
 *
 * `revalidate` is OPTIONAL here, unlike saveTrialDays. The gate and any future caller that only
 * means to change a number without a NextApiResponse to hand can omit it; the result then says
 * `attempted: []` and `verified: false`, which is the truth rather than a silent skip.
 */
export async function savePlanSettings(
  db: Db,
  opts: {
    changes: Partial<Record<PlanSettingField, number | boolean>>;
    actorId: string | null;
    settingsId?: string;
    revalidate?: (path: string) => Promise<unknown>;
    /** The origin to READ BACK. The apex in production; the gate and dev pass their own. */
    origin?: string;
  },
): Promise<SavePlanSettingsResult> {
  const id = opts.settingsId ?? SETTINGS_ID;
  const entries = Object.entries(opts.changes) as [PlanSettingField, number | boolean][];
  if (!entries.length) throw new Error('savePlanSettings: nothing to change');
  for (const [field, value] of entries) {
    if (!(PLAN_SETTING_FIELDS as readonly string[]).includes(field)) {
      throw new Error(`savePlanSettings: ${field} is not a plan setting. The list is closed on purpose.`);
    }
    const refusal = refusePlanSetting(field, value);
    if (refusal) throw new Error(refusal);
  }

  const before = await getProgrammeSettings(db, { settingsId: id });

  // CROSS-FIELD, OVER THE RESULT. Everything this save would leave behind, not only what it sends.
  const merged: Record<string, number | boolean> = {};
  for (const f of PLAN_SETTING_FIELDS) merged[f] = before[f];
  for (const [f, v] of entries) merged[f] = v;
  const combination = refusePlanCombination(merged);
  if (combination) throw new Error(combination);

  const changed: SavePlanSettingsResult['changed'] = {};
  const data: Record<string, number | boolean> = {};
  for (const [field, value] of entries) {
    if (before[field] === value) continue;   // not a change, so not an audit line
    changed[field] = { from: before[field], to: value };
    data[field] = value;
  }
  if (Object.keys(data).length) {
    await db.programmeSettings.update({ where: { id }, data });
    if (opts.actorId) {
      await db.superAdminAudit.create({
        data: {
          operator_user_id: opts.actorId,
          action: 'programme_plan_settings',
          target_group_id: null, target_operator_id: null,
          target_name_snapshot: 'Plan and reward settings',
          // OLD TO NEW, in the snapshot a person reads first, not only in the JSON.
          target_ref_snapshot: Object.entries(changed)
            .map(([f, c]) => `${f} ${c!.from} → ${c!.to}`).join('; ').slice(0, 300),
          detail: changed,
        },
      });
    }
  }

  const after = await getProgrammeSettings(db, { settingsId: id });

  // ── REFRESH THE PUBLIC COPY, THEN GO AND READ IT ────────────────────────────────────────────
  // Only when something actually changed: a save that moved nothing has no page to refresh, and
  // reporting "not verified" for it would teach the operator to ignore the line.
  let attempted: string[] = [];
  let revalidateError: string | null = null;
  let checks: CopyCheckText[] = [];
  let verified = false;
  let note: string | null = null;

  if (Object.keys(data).length && opts.revalidate) {
    for (const p of revalidationTargets()) {
      try { await opts.revalidate(p); attempted.push(p); }
      catch (e: any) { revalidateError = `${p}: ${describe(e)}`.slice(0, 300); }
    }
    // WHAT THE PAGE MUST NOW SAY, computed the way the page computes it rather than from the raw
    // column: the yearly price is renewal_annual_months_paid × monthly_price_pennies, and
    // re-deriving it here with a different expression is how a read-back starts agreeing with
    // itself instead of with the page.
    const want = yearlyPriceLabelFor(after);
    checks = await readPublicPlanCopy(opts.origin ?? publicOrigin(), want);
    if (!checks.every((c) => c.agrees)) {
      await new Promise((r) => setTimeout(r, 2000));
      checks = await readPublicPlanCopy(opts.origin ?? publicOrigin(), want);
    }
    verified = checks.length > 0 && checks.every((c) => c.agrees);
    note = verified ? null
      : revalidateError ? null
      : `the refresh was accepted but ${checks.filter((c) => !c.agrees).map((c) => `${c.url} still shows ${c.shows ?? 'no yearly price'}`).join('; ')}`.slice(0, 300);
  }

  return {
    changed,
    after: Object.fromEntries(PLAN_SETTING_FIELDS.map((f) => [f, after[f]])) as Record<PlanSettingField, number | boolean>,
    attempted, revalidateError, verified, checks, note,
  };
}

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
