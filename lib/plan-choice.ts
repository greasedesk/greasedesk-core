/**
 * File: lib/plan-choice.ts
 * THE ONE SERVER-SIDE ANSWER TO "what may this garage buy, and what will it cost?"
 *
 * ── WHY THIS EXISTS, WRITTEN DOWN BECAUSE THE GAP WAS INVISIBLE ────────────────────────────────
 * Annual billing shipped with a complete server side and no way to reach it. `checkout.ts` read
 * `plan` from the request body; the onboarding step posted `{ context: 'onboarding' }` and the
 * licences screen posted no body at all — so `wantsAnnual` was false on every real request and
 * MONTHLY WAS THE ONLY REACHABLE PLAN IN THE APPLICATION. Every gate for the slice exercised the
 * libraries and the API and not one went through a screen, so all of them were green.
 *
 * The fix is deliberately not "add a radio to two pages". It is ONE resolver that both screens
 * render from, so the price on the screen and the price Checkout charges are the same call on the
 * same request and cannot drift apart. A second copy of this arithmetic in a page is the defect,
 * not the shortcut.
 *
 * ── NEVER FROM REQUEST INPUT ───────────────────────────────────────────────────────────────────
 * The offer is resolved by offerFor(groupId) against the database. A request body may choose a
 * SHAPE ('monthly' | 'annual') and never an amount, never an entitlement to the offer — the rule
 * checkout.ts and change-plan.ts already follow, and the reason the screen cannot be trusted to
 * tell the server what it displayed.
 *
 * ── TWO KINDS OF FIGURE, AND THE DIFFERENCE MATTERS ────────────────────────────────────────────
 * Everything named `perLocation` / `perMonthEquiv` / `saving` is SHOP-WINDOW ARITHMETIC for one
 * location: it makes yearly comparable with monthly on the screen. Everything named `total` is
 * what the card is actually charged, for every location. The charge sentence uses the totals and
 * nothing else — so a garage with three sites reads "£62.50 /month per location" above "you'll
 * then be charged £2,250", and the number that leaves its bank is never the illustrative one.
 */
import { prisma as defaultDb } from '@/lib/db';
import {
  planSettings, renewalAnnualPennies, firstYearDiscountPennies,
  type PlanKind, type PlanSettings,
} from '@/lib/billing-plans';
import { offerFor } from '@/lib/affiliate';
import { formatMoney } from '@/lib/format-money';
import { getProfile, DEFAULT_COUNTRY, formatProfileDate, type CountryProfile } from '@/lib/locale-profiles';

type Db = typeof defaultDb;

export type PlanOption = {
  /** The SHAPE the body will carry. Never an amount. */
  choice: 'monthly' | 'annual';
  /** The plan kind the server resolved — 'annual_offer' vs 'annual_renewal' is decided here, not by the screen. */
  kind: PlanKind;
  perLocationPennies: number;
  totalPennies: number;
  perLocationLabel: string;
  totalLabel: string;
  /** THE HEADLINE. One location, one month, whatever the interval — the only way the two plans compare. */
  perMonthEquivPennies: number;
  perMonthEquivLabel: string;
  /** States the DATE and the AMOUNT charged when the trial ends (owner ruling, 2026-10-28). */
  trialSentence: string;
};

export type AnnualOption = PlanOption & {
  offerApplies: boolean;
  renewalTotalPennies: number;
  renewalTotalLabel: string;
  /** The renewal figure for ONE location, to sit beside the per-location first-year figure. */
  renewalPerLocationLabel: string;
  /** Months of service minus months charged, for the year being bought. Null when there is no saving to claim. */
  monthsFree: number | null;
  /** The two numbers the difference above came from. Exposed because the PUBLIC page states them
   *  ("12 months for the price of 8") and must not re-derive either from a literal. */
  monthsPaid: number;
  monthsGiven: number;
  /**
   * WHOSE offer this is, and what it buys — in one sentence, for the garage reading the panel.
   * Null when no offer applies. The NAME comes from the attribution (offerFor resolves it from the
   * same referrer the entitlement decision used) and the MONTHS from the settings; neither is typed
   * here, so an Engine Room edit or a renamed affiliate changes the sentence with nothing to update.
   */
  offerReason: string | null;
  /** Against twelve months of monthly, one location. Null when yearly saves nothing. */
  savingPerYearPennies: number | null;
  savingLabel: string | null;
  savingPercent: number | null;
  savingPercentLabel: string | null;
};

export type PlanChoice = {
  trialDays: number;
  trialEndsAt: string;
  trialEndsLabel: string;
  sites: number;
  monthly: PlanOption;
  annual: AnnualOption;
};

/** Whole pounds, through the one money chokepoint — plan prices themselves are never fractional. */
const money = (pennies: number, p: CountryProfile): string =>
  formatMoney(pennies, { currency: p.currency, locale: p.locale, maximumFractionDigits: 0 });

/**
 * Pence ONLY when there are pence. The monthly equivalent of £750 is £62.50 and writing it "£63"
 * would overstate the plan by six pounds a year; writing £75 as "£75.00" beside it would make the
 * two headlines read as different kinds of number.
 */
const moneyExact = (pennies: number, p: CountryProfile): string =>
  formatMoney(pennies, { currency: p.currency, locale: p.locale, maximumFractionDigits: pennies % 100 === 0 ? 0 : 2 });

/**
 * Everything the arithmetic below needs to know about the offer — the subset of offerFor's answer
 * that decides a price. Named so the PUBLIC page can supply one without a garage to resolve it
 * against; see publicPlanChoice.
 */
type ResolvedOffer = {
  plan: PlanKind;
  annualPennies: number;
  discountPennies: number;
  monthsPaid: number;
  monthsGiven: number;
  referrerName: string | null;
};

/**
 * THE REFERRAL LINE ON THE PUBLIC PAGE, by CODE rather than by name.
 *
 * Signed in, a garage is told whose offer it is: "Referral offer from G B Jones — …". Signed out,
 * naming the affiliate would publish who they are to anyone who guesses a code, so the public line
 * echoes the code the visitor already arrived with and nothing we know about its owner.
 *
 * The two month figures are PASSED IN from the resolved choice, never typed here: the day
 * months_given moves in the Engine Room this sentence moves with it.
 *
 * The code is echoed only after /api/affiliate/check-code has said it is one we know, and it is
 * normalised first — an arbitrary query string rendered back to a visitor is somebody else's
 * sentence printed in our voice.
 */
export const PUBLIC_REF_MAX = 32;
export const normaliseRefCode = (raw: string | null | undefined): string | null => {
  const v = (raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,31}$/.test(v) ? v : null;
};
export const publicReferralSentence = (code: string, monthsGiven: number, monthsPaid: number): string =>
  `Referral code ${code}: your first year is ${monthsGiven} months for the price of ${monthsPaid}.`;

export async function planChoiceFor(
  db: Db = defaultDb,
  groupId: string,
  opts: {
    country?: string | null; sites?: number; trialEndsAt?: Date | null; settingsId?: string;
    /** Already read by the caller. checkout.ts resolves both before it needs the labels, and a
     *  second read here is how a price from one read lands beside a month count from another. */
    settings?: PlanSettings;
    offer?: Awaited<ReturnType<typeof offerFor>>;
  } = {},
): Promise<PlanChoice> {
  // ONE READ, PASSED ON (owner, 2026-10-29). This used to read the settings and then let offerFor
  // read them again, so a price from the first read could appear beside a month count from the
  // second. The window is small and the symptom is a screen that contradicts itself.
  const settings = opts.settings ?? await planSettings(db, { settingsId: opts.settingsId, country: opts.country });
  const offer = opts.offer ?? await offerFor(db, groupId, { settingsId: opts.settingsId, settings });
  return buildChoice(settings, offer, opts);
}

/**
 * ── THE SAME FIGURES, WITH NO GARAGE TO RESOLVE THEM AGAINST (owner, 2026-10-29) ───────────────
 * The public pricing page shows what a visitor would pay, and a visitor has no group id, no
 * attribution row and no frozen terms. So the offer is SYNTHESISED from today's settings rather
 * than looked up — which is the honest answer for someone who has not signed up: nothing is
 * frozen yet, and the live setting is exactly what they will be quoted when they do.
 *
 * `referred` is the only input, and it is a BOOLEAN, never an amount or a code. Validity is
 * decided elsewhere (the signup path resolves the code against the database; the public page asks
 * /api/affiliate/check-code); this function is told yes or no and prices accordingly. A page that
 * could pass in its own discount would be a page that sets the price.
 *
 * NO NAME, EVER. `referrerName: null` is not an omission — the public page must not publish who an
 * affiliate is (an unauthenticated page naming them is a way to enumerate the affiliate list), so
 * offerReason comes out as the nameless sentence by construction rather than by the page
 * remembering to hide it.
 */
export async function publicPlanChoice(
  db: Db = defaultDb,
  opts: { country?: string | null; sites?: number; referred?: boolean; settingsId?: string } = {},
): Promise<PlanChoice> {
  const settings = await planSettings(db, { settingsId: opts.settingsId, country: opts.country });
  const referred = !!opts.referred;
  const offer: ResolvedOffer = {
    plan: referred ? 'annual_offer' : 'annual_renewal',
    annualPennies: renewalAnnualPennies(settings),
    // ONE LOCATION, matching offerFor, which also answers per location. buildChoice multiplies.
    discountPennies: referred ? firstYearDiscountPennies(settings, 1) : 0,
    monthsPaid: referred ? settings.offerMonthsPaid : settings.renewalAnnualMonthsPaid,
    monthsGiven: settings.monthsGiven,
    referrerName: null,
  };
  return buildChoice(settings, offer, opts);
}

function buildChoice(
  settings: PlanSettings,
  offer: ResolvedOffer,
  opts: { country?: string | null; sites?: number; trialEndsAt?: Date | null } = {},
): PlanChoice {
  const profile = getProfile(opts.country ?? DEFAULT_COUNTRY);
  const sites = Math.max(1, Math.trunc(opts.sites ?? 1));

  // THE TRIAL END. Passed in when the trial is already running (Group.trial_ends_at, which
  // lib/stripe-billing-cache mirrors back from Stripe's own trial_end, so Stripe owns the clock).
  // Computed only when there is no subscription yet — and then it is exactly what Checkout will
  // seed from the same setting on this same request.
  const endsAt = opts.trialEndsAt ?? new Date(Date.now() + settings.trialDays * 24 * 60 * 60 * 1000);
  const endsLabel = formatProfileDate(profile, endsAt, { long: true });

  const monthlyTotal = settings.monthlyPricePennies * sites;

  // PER SITE from offerFor (it answers for one location); the totals are the per-site figures times
  // the count, which is exactly what Checkout does with `quantity` on a per-unit price.
  const firstYearPerLocation = offer.annualPennies - offer.discountPennies;
  const firstYearTotal = firstYearPerLocation * sites;
  const renewalTotal = offer.annualPennies * sites;

  // THE MONTHS COME FROM THE SAME ANSWER AS THE PRICE. Re-deriving them here through planFor was
  // how the reason line could say "price of 6" under a £600 headline: planFor reads today's
  // settings, while the price may be this garage's FROZEN offer. offerFor reports the months it
  // actually charged for, frozen or live, and that is the only honest source for the sentence.
  const monthsPaid = offer.monthsPaid;
  const monthsGiven = offer.monthsGiven;
  // ZERO IS NOT A SAVING AND A NEGATIVE ONE IS NOT A SENTENCE. Settings can legitimately be set so
  // that annual saves nothing; claiming "0 months free" would be a worse lie than saying nothing.
  const monthsFree = monthsGiven - monthsPaid > 0 ? monthsGiven - monthsPaid : null;

  // ── THE COMPARISON FIGURES, DERIVED AND NEVER TYPED (owner ruling, 2026-10-29) ────────────────
  // The percentage is the owner's formula, (months given − months paid) ÷ months given, written
  // against monthsGiven rather than a literal 12 for the same reason the saving is not typed: the
  // day months_given moves in the Engine Room, a 12 here becomes a wrong percentage on the signup
  // screen with nothing to catch it. At months_given = 12 the two are the same arithmetic.
  //
  // The headline is ROUNDED to the penny and is an EQUIVALENCE, not a charge: nothing bills
  // monthly on the yearly plan. The charge sentence below carries the figure that is really taken.
  const perMonthEquivPennies = Math.round(firstYearPerLocation / monthsGiven);
  const savingRaw = settings.monthlyPricePennies * monthsGiven - firstYearPerLocation;
  const savingPerYearPennies = savingRaw > 0 ? savingRaw : null;
  const savingPercent = monthsFree === null ? null : Math.round((monthsFree / monthsGiven) * 100);

  return {
    trialDays: settings.trialDays,
    trialEndsAt: endsAt.toISOString(),
    trialEndsLabel: endsLabel,
    sites,
    monthly: {
      choice: 'monthly',
      kind: 'monthly',
      perLocationPennies: settings.monthlyPricePennies,
      totalPennies: monthlyTotal,
      perLocationLabel: money(settings.monthlyPricePennies, profile),
      totalLabel: money(monthlyTotal, profile),
      perMonthEquivPennies: settings.monthlyPricePennies,
      perMonthEquivLabel: moneyExact(settings.monthlyPricePennies, profile),
      trialSentence: `Your trial ends on ${endsLabel}. You’ll then be charged ${money(monthlyTotal, profile)} a month.`,
    },
    annual: {
      choice: 'annual',
      kind: offer.plan,
      perLocationPennies: firstYearPerLocation,
      totalPennies: firstYearTotal,
      perLocationLabel: money(firstYearPerLocation, profile),
      totalLabel: money(firstYearTotal, profile),
      perMonthEquivPennies,
      perMonthEquivLabel: moneyExact(perMonthEquivPennies, profile),
      offerApplies: offer.discountPennies > 0,
      renewalTotalPennies: renewalTotal,
      renewalTotalLabel: money(renewalTotal, profile),
      renewalPerLocationLabel: money(offer.annualPennies, profile),
      monthsFree,
      monthsPaid,
      monthsGiven,
      // A NAME WE NO LONGER HAVE IS NOT A REASON TO HIDE THE OFFER. If the rep row has gone the
      // sentence drops the "from X" clause and still explains the price, because the price is the
      // part the garage is about to be charged.
      offerReason: offer.discountPennies <= 0
        ? null
        : offer.referrerName
          ? `Referral offer from ${offer.referrerName} — your first year is ${monthsGiven} months for the price of ${monthsPaid}.`
          : `Referral offer — your first year is ${monthsGiven} months for the price of ${monthsPaid}.`,
      savingPerYearPennies,
      savingLabel: savingPerYearPennies === null ? null : `Save ${money(savingPerYearPennies, profile)} a year`,
      savingPercent,
      savingPercentLabel: savingPercent === null || savingPercent <= 0 ? null : `Save ${savingPercent}%`,
      // BOTH PRICES WHEN AN OFFER APPLIES. A first-year price shown alone is a mis-sale: the
      // garage would learn the real figure from its second invoice.
      trialSentence: offer.discountPennies > 0
        ? `Your trial ends on ${endsLabel}. You’ll then be charged ${money(firstYearTotal, profile)} for your first year, then ${money(renewalTotal, profile)} a year.`
        : `Your trial ends on ${endsLabel}. You’ll then be charged ${money(renewalTotal, profile)} for ${monthsGiven} months.`,
    },
  };
}
