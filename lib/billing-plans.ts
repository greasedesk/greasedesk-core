/**
 * File: lib/billing-plans.ts
 * THE plan shapes GreaseDesk sells, and the arithmetic that prices them.
 *
 * ── TRIAL OR PAY NOW, NEVER BOTH (owner, 2026-10-24) ────────────────────────────────────────────
 * A new garage on annual pays immediately for twelve months at the price of nine — the trial IS
 * the discount, taken once, at the front. Monthly keeps the trial. The affiliate offer is twelve
 * for six, by code, once per garage. A renewal of any annual plan is twelve for ten.
 *
 * THE RULE IS STRUCTURAL, NOT CHECKED AFTERWARDS. There are two factories below and no third:
 * `monthlyPlan` sets a trial and a zero payment, `annualPlan` sets a zero trial and a payment.
 * No code path can produce both, so the invariant cannot be broken by editing a number — only by
 * writing a new factory, which is a thing a reader can see.
 *
 * ── THE PRICES ARE DERIVED, NEVER TYPED (owner ruling 4, 2026-10-24) ────────────────────────────
 * Changing months-paid in the Engine Room must not require a Stripe Price to be created by hand.
 * So an annual amount is arithmetic over the settings and the monthly price — admin changes a
 * number, and Stripe is told an amount. Nothing here reads a Price id.
 *
 * ── ONE COUNTRY'S PRICE AT A TIME ───────────────────────────────────────────────────────────────
 * `planFor` is pure and takes the monthly price in pennies, so it never assumes a country.
 * `planSettings` resolves one: the tenant's if a country is given, else the default profile's.
 * A multi-country annual plan therefore costs nothing extra to add — pass the country.
 */
import { prisma as defaultDb } from '@/lib/db';
import { getProgrammeSettings } from '@/lib/programme-settings';
import { getProfile, DEFAULT_COUNTRY } from '@/lib/locale-profiles';

type Db = any; // a PrismaClient or an interactive-transaction client

export const PLAN_KINDS = ['monthly', 'annual_new', 'annual_offer', 'annual_renewal'] as const;
export type PlanKind = typeof PLAN_KINDS[number];

export type PlanSettings = {
  monthlyPricePennies: number;
  trialDays: number;
  newAnnualMonthsPaid: number;
  renewalAnnualMonthsPaid: number;
  offerMonthsPaid: number;
  monthsGiven: number;
};

export type Plan = {
  kind: PlanKind;
  interval: 'month' | 'year';
  /** Days of trial. Greater than zero ONLY on monthly. */
  trialDays: number;
  /** Taken at checkout, in pennies. Greater than zero ONLY on the annual shapes. */
  payNowPennies: number;
  /** Months charged for. NULL on monthly: there is no "months paid for" on a rolling plan. */
  monthsPaid: number | null;
  /** Months of service received. NULL on monthly, for the same reason. */
  monthsGiven: number | null;
};

/** Why these settings cannot produce a sellable plan, or null. */
export function refusePlanSettings(s: PlanSettings): string | null {
  if (!Number.isFinite(s.monthlyPricePennies) || s.monthlyPricePennies <= 0) return 'The monthly price must be a positive amount.';
  if (!Number.isInteger(s.trialDays) || s.trialDays < 1) {
    // A zero-day trial would make MONTHLY have neither a trial nor a payment — a plan that
    // gives service for nothing, with nothing to charge later. Refused rather than normalised.
    return 'The trial length must be at least one day, or the monthly plan offers neither a trial nor a payment.';
  }
  for (const [name, v] of [['new annual', s.newAnnualMonthsPaid], ['renewal annual', s.renewalAnnualMonthsPaid], ['offer', s.offerMonthsPaid]] as const) {
    if (!Number.isInteger(v) || v < 1) return `The ${name} months-paid must be at least 1; an annual plan that charges nothing is not a plan.`;
  }
  if (!Number.isInteger(s.monthsGiven) || s.monthsGiven < 1) return 'Months given must be at least 1.';
  return null;
}

const monthlyPlan = (s: PlanSettings): Plan => ({
  kind: 'monthly', interval: 'month',
  trialDays: s.trialDays, payNowPennies: 0,
  monthsPaid: null, monthsGiven: null,
});

const annualPlan = (kind: PlanKind, monthsPaid: number, s: PlanSettings, sites: number): Plan => ({
  kind, interval: 'year',
  trialDays: 0, payNowPennies: monthsPaid * s.monthlyPricePennies * sites,
  monthsPaid, monthsGiven: s.monthsGiven,
});

/**
 * The plan of this shape, at these settings, for this many sites. PURE — give it the numbers.
 * Throws on settings that cannot produce a sellable plan: a caller that has not checked is a
 * caller about to put a wrong price in front of a customer.
 */
export function planFor(kind: PlanKind, s: PlanSettings, sites = 1): Plan {
  const refusal = refusePlanSettings(s);
  if (refusal) throw new Error(`planFor(${kind}): ${refusal}`);
  if (!Number.isInteger(sites) || sites < 1) throw new Error(`planFor(${kind}): sites must be at least 1`);
  switch (kind) {
    case 'monthly': return monthlyPlan(s);
    case 'annual_new': return annualPlan(kind, s.newAnnualMonthsPaid, s, sites);
    case 'annual_offer': return annualPlan(kind, s.offerMonthsPaid, s, sites);
    case 'annual_renewal': return annualPlan(kind, s.renewalAnnualMonthsPaid, s, sites);
    // No default. Adding a kind to PLAN_KINDS without a case here fails to compile, which is the
    // point of the switch being exhaustive rather than a lookup with a fallback.
  }
}

/** The six numbers, from the programme settings and the country's monthly price. */
export async function planSettings(
  db: Db = defaultDb,
  opts: { settingsId?: string; country?: string | null } = {},
): Promise<PlanSettings> {
  const s = await getProgrammeSettings(db, { settingsId: opts.settingsId });
  const profile = getProfile(opts.country ?? DEFAULT_COUNTRY);
  return {
    monthlyPricePennies: Math.round(profile.monthlyPrice * 100),
    trialDays: s.trial_days,
    newAnnualMonthsPaid: s.new_annual_months_paid,
    renewalAnnualMonthsPaid: s.renewal_annual_months_paid,
    offerMonthsPaid: s.offer_months_paid,
    monthsGiven: s.months_given,
  };
}

/**
 * APPEND the terms a garage is now on. Never an update: TenantPlanTerms is a timeline (see the
 * schema), so the earliest row is what they signed up under and the latest is what they are on.
 * Rewriting a row would erase the terms somebody agreed to, which is the whole reason the table
 * stopped being one row per garage.
 */
export async function writePlanTerms(
  db: Db,
  groupId: string,
  plan: Plan,
  opts: { at?: Date } = {},
) {
  return db.tenantPlanTerms.create({
    data: {
      group_id: groupId,
      plan: plan.kind,
      months_paid: plan.monthsPaid,
      months_given: plan.monthsGiven,
      // NULL on monthly, and that is a meaningful absence rather than zero: nothing is taken at
      // signup, and a zero would read as a payment of nothing having been collected.
      paid_now_pennies: plan.payNowPennies > 0 ? plan.payNowPennies : null,
      trial_days: plan.trialDays > 0 ? plan.trialDays : null,
      effective_from: opts.at ?? new Date(),
    },
  });
}

/**
 * THE TERMS A BRAND-NEW GARAGE STARTS ON — monthly, with the trial length in force today.
 *
 * Every path that creates a garage calls this, so no garage exists without a first timeline
 * entry. The backfill on 2026-10-24 gave every EXISTING garage one on the stated principle that
 * there is one shape for every garage; signup did not write one, so the very next garage to
 * register would have broken that the day after it was established.
 *
 * MONTHLY, ALWAYS, at this point. A garage starts on the trial; annual is a choice made later, at
 * checkout, and it APPENDS a second row rather than editing this one.
 *
 * IDEMPOTENT BY EXISTENCE, not by a flag: it writes only when the garage has no terms at all. The
 * two call sites are a signup endpoint and an onboarding upsert that may run again, and "exactly
 * one row" has to survive both. It is deliberately NOT "write if no monthly row" — a garage that
 * has moved to annual has terms, and starting terms are not something to re-add underneath them.
 */
export async function ensureStartingPlanTerms(
  db: Db,
  groupId: string,
  opts: { settingsId?: string; country?: string | null; at?: Date } = {},
) {
  const existing = await db.tenantPlanTerms.findFirst({ where: { group_id: groupId }, select: { id: true } });
  if (existing) return null;
  const s = await planSettings(db, opts);
  return writePlanTerms(db, groupId, planFor('monthly', s), { at: opts.at });
}

/** What this garage is on NOW — the latest row. Null when no terms were ever written. */
export async function currentPlanTerms(db: Db, groupId: string) {
  return db.tenantPlanTerms.findFirst({
    where: { group_id: groupId },
    orderBy: { effective_from: 'desc' },
  });
}

/** What this garage SIGNED UP under — the earliest row. A different question, and both are asked. */
export async function signupPlanTerms(db: Db, groupId: string) {
  return db.tenantPlanTerms.findFirst({
    where: { group_id: groupId },
    orderBy: { effective_from: 'asc' },
  });
}
