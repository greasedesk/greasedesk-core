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
 */
import { prisma as defaultDb } from '@/lib/db';
import { planFor, planSettings, type PlanKind } from '@/lib/billing-plans';
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
  /** States the DATE and the AMOUNT charged when the trial ends (owner ruling, 2026-10-28). */
  trialSentence: string;
};

export type AnnualOption = PlanOption & {
  offerApplies: boolean;
  renewalTotalPennies: number;
  renewalTotalLabel: string;
  /** Months of service minus months charged, for the year being bought. Null when there is no saving to claim. */
  monthsFree: number | null;
  savingLabel: string | null;
};

export type PlanChoice = {
  trialDays: number;
  trialEndsAt: string;
  trialEndsLabel: string;
  sites: number;
  monthly: PlanOption;
  annual: AnnualOption;
};

/** Whole pounds, through the one money chokepoint — plan prices are never fractional. */
const money = (pennies: number, p: CountryProfile): string =>
  formatMoney(pennies, { currency: p.currency, locale: p.locale, maximumFractionDigits: 0 });

export async function planChoiceFor(
  db: Db = defaultDb,
  groupId: string,
  opts: { country?: string | null; sites?: number; trialEndsAt?: Date | null; settingsId?: string } = {},
): Promise<PlanChoice> {
  const profile = getProfile(opts.country ?? DEFAULT_COUNTRY);
  const settings = await planSettings(db, { settingsId: opts.settingsId, country: opts.country });
  const offer = await offerFor(db, groupId, { settingsId: opts.settingsId });
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

  const annualPlan = planFor(offer.plan, settings, sites);
  const monthsPaid = annualPlan.monthsPaid ?? 0;
  const monthsGiven = annualPlan.monthsGiven ?? settings.monthsGiven;
  // ZERO IS NOT A SAVING AND A NEGATIVE ONE IS NOT A SENTENCE. Settings can legitimately be set so
  // that annual saves nothing; claiming "0 months free" would be a worse lie than saying nothing.
  const monthsFree = monthsGiven - monthsPaid > 0 ? monthsGiven - monthsPaid : null;

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
      trialSentence: `Your trial ends on ${endsLabel}. You’ll then be charged ${money(monthlyTotal, profile)} a month.`,
    },
    annual: {
      choice: 'annual',
      kind: offer.plan,
      perLocationPennies: firstYearPerLocation,
      totalPennies: firstYearTotal,
      perLocationLabel: money(firstYearPerLocation, profile),
      totalLabel: money(firstYearTotal, profile),
      offerApplies: offer.discountPennies > 0,
      renewalTotalPennies: renewalTotal,
      renewalTotalLabel: money(renewalTotal, profile),
      monthsFree,
      // DERIVED, NEVER TYPED (owner ruling, 2026-10-28). A typed "two months free" becomes a lie
      // the first time anybody changes renewal_annual_months_paid in the Engine Room.
      savingLabel: monthsFree === null
        ? null
        : `${monthsFree} months free — ${monthsGiven} months for the price of ${monthsPaid}`,
      // BOTH PRICES WHEN AN OFFER APPLIES. A first-year price shown alone is a mis-sale: the
      // garage would learn the real figure from its second invoice.
      trialSentence: offer.discountPennies > 0
        ? `Your trial ends on ${endsLabel}. You’ll then be charged ${money(firstYearTotal, profile)} for your first year, then ${money(renewalTotal, profile)} a year.`
        : `Your trial ends on ${endsLabel}. You’ll then be charged ${money(renewalTotal, profile)} for ${monthsGiven} months.`,
    },
  };
}
