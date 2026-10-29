/**
 * File: lib/billing-plans.ts
 * THE plan shapes GreaseDesk sells, and the arithmetic that prices them.
 *
 * ── EVERY GARAGE GETS THE TRIAL (owner, 2026-10-28 — THIS REVERSES 2026-10-24) ──────────────────
 * The rule here used to be TRIAL OR PAY NOW, NEVER BOTH: annual paid at the front and had no
 * trial, because "the trial IS the discount, taken once". That is no longer the offer. Every
 * garage now gets the trial whatever plan it picks, and is charged its chosen plan when
 * the trial ends — monthly £75, annual renewal_annual_months_paid × monthly for the twelve months
 * from that date, the affiliate offer offer_months_paid for the first year and the renewal figure
 * after it.
 *
 * SO AN ANNUAL GARAGE GETS THIRTEEN MONTHS OF SERVICE FOR ITS FIRST PAYMENT, and that is
 * intended, not a rounding error in the rule. It is written down here because a future reader
 * finding "12 months" beside a trial of any length will otherwise read it as the bug it looks like.
 *
 * WHAT THE REVERSAL COST, so nobody re-derives it: the DB CHECK `TenantPlanTerms_trial_xor_paynow`
 * encoded the old rule physically and had to be replaced (see the 2026-10-28 migration), the two
 * factories below both set a trial now, refusePlanCombination stopped refusing annual-with-a-trial,
 * and four clauses in billing-plans-gate asserted the XOR. The invariant that REMAINS structural is
 * the one in the factories: monthly never takes money at signup, annual always does.
 *
 * ── THE PRICE A GARAGE SIGNS UP AT IS THE PRICE IT KEEPS ────────────────────────────────────────
 * An annual subscription is created at the amount these settings produce on the day, and renews at
 * that amount. Changing months-paid in the Engine Room moves NEW garages only; nothing reaches
 * back into a live subscription. That is the same promise TenantPlanTerms and TenantAffiliateTerms
 * make, and the Engine Room says so on the screen.
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

/** The annual shapes, as a set: everything that is not the rolling monthly plan. */
export const isAnnualKind = (k: PlanKind | null | undefined): boolean => !!k && k !== 'monthly';

/**
 * A GARAGE THAT HAS PAID FOR A YEAR CANNOT DROP TO MONTHLY (owner, 2026-10-29).
 *
 * It has bought twelve months of service and the money is collected. Dropping to monthly mid-term
 * is a credit note, a proration and a refund policy, and none of those are built. So the door is
 * CLOSED rather than guessed at: the switch control is absent and the API refuses, with the one
 * sentence that is actually true — the plan can be changed at renewal.
 *
 * ── WHY THE TEST IS "ON AN ANNUAL PLAN AND HAS PAID", NOT "HAS PAID AN ANNUAL INVOICE" ─────────
 * `first_paid_at` records the first non-zero invoice of any kind, so on its own it does not say
 * WHICH plan was paid for. It does not need to: switching is a trial-only door, nothing is
 * collected during a trial, and so a garage cannot have paid under one plan and then moved to
 * another. Annual tail + money taken therefore means the money was taken for the year.
 *
 * THAT PREMISE IS LOAD-BEARING. If a switch is ever allowed after the first charge — the board
 * item is "annual → monthly in the last 14 days before renewal, taking effect at renewal" — this
 * predicate stops being able to tell the two apart and must read the paid invoice itself.
 *
 * Note it is NOT the same question as `trialing`. Today the status covers almost every case,
 * because a paid garage is `active`. "Almost" is the problem: a subscription can read `trialing`
 * with money already taken (a trial extended in the Stripe dashboard after a charge, a pause and
 * resume), and in that gap the old code would have offered the switch and change-plan would have
 * taken it.
 */
export function annualPaidIn(a: { plan: PlanKind | null | undefined; firstPaidAt: Date | null | undefined }): boolean {
  return isAnnualKind(a.plan) && !!a.firstPaidAt;
}

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
    // EVERY plan carries the trial now, so a zero here is not a monthly-only problem: it would
    // make the signup promise of a free trial untrue on both plans. Refused, never normalised.
    return 'The trial length must be at least one day; every plan is sold with a trial.';
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

// `payNowPennies` is what the garage is charged WHEN THE TRIAL ENDS, not at the checkout screen.
// The name predates the reversal and is kept: it is still the one payment this plan takes up
// front for the whole term, and renaming it would touch the frozen TenantPlanTerms column.
const annualPlan = (kind: PlanKind, monthsPaid: number, s: PlanSettings, sites: number): Plan => ({
  kind, interval: 'year',
  trialDays: s.trialDays, payNowPennies: monthsPaid * s.monthlyPricePennies * sites,
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
 *
 * ── AND ONLY ON A CHANGE, UNDER A LOCK (2026-10-29, after a duplicate reached a real garage) ───
 * The compare used to live in the CALLER — lib/stripe-billing-cache read currentPlanTerms, found
 * a different shape, and called this function, which created unconditionally. Checkout B exposed
 * what that costs: `checkout.session.completed` and `customer.subscription.created` arrived 168ms
 * apart, both read `monthly`, both decided the shape had changed, and GB-GD2491 ended up with two
 * identical annual_renewal rows. Nothing summed them, so it cost records rather than money — but
 * it is a money timeline, and a read followed by a write with nothing in between is not a check.
 *
 * So the compare moved in here, where it can be done under a lock on the garage's own Group row:
 * the second writer BLOCKS on the lock, and when it gets it the tail is the row the first writer
 * inserted, so it finds no change and writes nothing. One row, from two racing webhooks, enforced
 * by the database rather than by both callers hoping.
 *
 * THREE THINGS A READER WILL WANT TO KNOW:
 *  - Two of the four call sites (register-garage, onboarding/setup) pass an interactive
 *    transaction client, which has no `$transaction` of its own. So a transaction is opened only
 *    when we were handed a root client; inside a caller's transaction the lock simply joins it and
 *    is held until they commit, which is what we want anyway.
 *  - The pooled Neon endpoint is safe for this. PgBouncer in transaction mode pins one server
 *    connection for the life of a transaction, so BEGIN/SELECT FOR UPDATE/INSERT/COMMIT all run on
 *    the same connection. A SESSION-scoped advisory lock would NOT survive that, which is why the
 *    lock is a row lock and not pg_advisory_lock.
 *  - FOR UPDATE on a row that does not exist locks nothing and serialises nothing. Every caller
 *    holds a real group (the insert's foreign key would fail otherwise), so this is a premise of
 *    the callers rather than a hole here — but it is a premise, and it is written down.
 *
 * Returns the row the garage is on afterwards: the one just inserted, or the existing tail when
 * the shape had not changed. A caller therefore always gets terms back, never null.
 */
export async function writePlanTerms(
  db: Db,
  groupId: string,
  plan: Plan,
  opts: { at?: Date } = {},
) {
  const body = async (tx: Db) => {
    // THE LOCK, FIRST. Parameterised through the tagged template — never interpolated.
    //
    // FOR NO KEY UPDATE, NOT FOR UPDATE, AND THE DIFFERENCE IS NOT COSMETIC. Inserting any row
    // that references a Group takes a FOR KEY SHARE lock on that Group row — every job card,
    // customer, booking and invoice for the tenant. FOR UPDATE conflicts with FOR KEY SHARE, so
    // locking the row that way would stall unrelated writes across the whole garage for as long as
    // this transaction lived (and for as long as the CALLER's transaction lives, at the two call
    // sites that hand us one — signup, which does plenty afterwards). FOR NO KEY UPDATE conflicts
    // with itself and with FOR UPDATE, so two of these writers still serialise, while a job card
    // being saved at the same moment does not wait for us.
    //
    // Found by a red-proof: with FOR UPDATE the "second writer blocks" clause passed even with the
    // lock removed, because the loser was blocking on the foreign key instead. The clause was
    // measuring the wrong thing, and the wrong thing was also a product defect.
    await tx.$queryRaw`SELECT 1 FROM "Group" WHERE id = ${groupId} FOR NO KEY UPDATE`;
    const tail = await currentPlanTerms(tx, groupId);
    // ONLY ON A CHANGE. Re-writing the same shape on every subscription.updated would bury the one
    // row that says what they signed up under beneath hundreds that say nothing new.
    if (tail?.plan === plan.kind) return tail;
    return tx.tenantPlanTerms.create({
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
  };
  // A root client can open a transaction; a transaction client cannot, and asking it to would
  // throw. Either way the lock and the insert end up in ONE transaction.
  return typeof (db as any)?.$transaction === 'function' ? db.$transaction((tx: Db) => body(tx)) : body(db);
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

// ── WHAT STRIPE IS ASKED FOR, AS PLAIN DATA ──────────────────────────────────────────────────────
// Pure builders: they take a Plan and return the shape Checkout is handed. Pure so the gate can
// assert the amounts, the interval, the tax behaviour and the coupon WITHOUT a Stripe key and
// without a network call — no gate calls Stripe, and these are the only things worth asserting.

/** Terms v2: the published price INCLUDES VAT. A constant, as in checkout.ts, for the same reason. */
export const TAX_BEHAVIOR = 'inclusive' as const;

/**
 * The recurring line for a plan. Monthly names the configured Price id; annual is an INLINE
 * amount on the SAME product, which is what makes the two give identical access (lib/modules).
 *
 * The annual amount is the RENEWAL figure, always — never the discounted one. A subscription
 * created at £600 would renew at £600 for ever, and the offer is for the first year. The discount
 * is a separate, once-only coupon; see firstYearDiscountPennies.
 */
export function subscriptionLineFor(
  plan: Plan,
  opts: { monthlyPriceId: string | null; coreProductId: string | null; renewalPennies: number; currency: string; quantity: number },
): { price: string; quantity: number } | { price_data: Record<string, unknown>; quantity: number } {
  if (plan.interval === 'month') {
    if (!opts.monthlyPriceId) throw new Error('subscriptionLineFor: monthly needs STRIPE_PRICE_ID');
    return { price: opts.monthlyPriceId, quantity: opts.quantity };
  }
  if (!opts.coreProductId) throw new Error('subscriptionLineFor: annual needs the Core product id');
  if (!Number.isInteger(opts.renewalPennies) || opts.renewalPennies <= 0) {
    throw new Error(`subscriptionLineFor: renewal amount must be a positive integer, got ${opts.renewalPennies}`);
  }
  return {
    price_data: {
      product: opts.coreProductId,
      currency: opts.currency,
      recurring: { interval: 'year' },
      unit_amount: opts.renewalPennies,
      tax_behavior: TAX_BEHAVIOR,
    },
    quantity: opts.quantity,
  };
}

/** What one site's annual renewal costs: the renewal months, never the offer months. */
export const renewalAnnualPennies = (s: PlanSettings): number => s.renewalAnnualMonthsPaid * s.monthlyPricePennies;

/**
 * THE FIRST-YEAR DISCOUNT, DERIVED — the gap between what a referred garage pays and what the
 * plan renews at. Zero when the settings leave no gap, which is a real state: offer_months_paid
 * and renewal_annual_months_paid were both 10 until 2026-10-26, and a £0 coupon is not something
 * to send to Stripe.
 */
export function firstYearDiscountPennies(s: PlanSettings, sites = 1): number {
  const gap = s.renewalAnnualMonthsPaid - s.offerMonthsPaid;
  return gap > 0 ? gap * s.monthlyPricePennies * sites : 0;
}

/**
 * The coupon id for a discount of this size. DETERMINISTIC, so the same settings reuse one coupon
 * and changed settings make a NEW one rather than mutating a coupon that live subscriptions point
 * at. `duration: 'once'` is the whole mechanism by which the offer is a FIRST-YEAR offer: it comes
 * off the first invoice and the subscription's own amount is the renewal figure throughout.
 */
export const firstYearCouponId = (pennies: number, currency: string): string =>
  `gd-first-year-${pennies}-${currency.toLowerCase()}`;

export function firstYearCouponSpec(pennies: number, currency: string): Record<string, unknown> {
  return {
    id: firstYearCouponId(pennies, currency),
    amount_off: pennies,
    currency: currency.toLowerCase(),
    duration: 'once',
    name: `First year — ${(pennies / 100).toFixed(2)} off`,
  };
}
