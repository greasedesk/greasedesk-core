/**
 * File: lib/trial-wording.ts
 * HOW WE DESCRIBE THE TRIAL. One module, because the same promise is made on eleven surfaces.
 *
 * ── WHY "FREE" IS GONE (owner ruling, 2026-10-29) ───────────────────────────────────────────────
 * "Start your N-day free trial" is a true sentence that sets a false expectation: a card is taken
 * at signup, and on its last day the card is charged. A garage that read "free" and then saw
 * money leave its
 * account was told the truth and still surprised, which is the one outcome the dashboard
 * banner's own ruling forbids — "if a customer is ever surprised by a charge, we failed."
 *
 * So the wording states what HAPPENS and WHEN: the length, the date of the first payment, and that
 * cancelling before it costs nothing. The word "free" describes the trial period accurately
 * and the arrangement inaccurately, so it is not used for the trial anywhere we control.
 *
 * ── TWO SHAPES, BECAUSE A PUBLIC PAGE HAS NO DATE ───────────────────────────────────────────────
 * Before signup there is no trial and therefore no end date; a date computed from "now" on an
 * ISR-cached marketing page would be frozen at render and quietly wrong. So:
 *   undated  — a visitor:  "<N>-day trial, nothing to pay for the first <N> days"
 *   dated    — a garage:   "Nothing to pay until <the day the card is charged>."
 * The dated forms REFUSE to render without a date rather than falling back to a vague one, so a
 * caller that forgot to pass the trial end gets an obviously-wrong string in review instead of a
 * promise with the date silently removed.
 *
 * ── WHAT WE CANNOT CHANGE ───────────────────────────────────────────────────────────────────────
 * Stripe Checkout prints its own "N days free" headline above the card form from the
 * subscription's trial_period_days. It is Stripe's string, not ours, and there is no parameter for
 * it. `checkoutCustomText` below is what we CAN put next to the button, and it is written to be the
 * plain version of the same fact so the two do not read as a contradiction.
 *
 * A LEAF MODULE: lib/locale-profiles only, which is itself a leaf. Safe on both sides of the bundle.
 */
import { formatProfileDate, type CountryProfile } from '@/lib/locale-profiles';

/** The public, dateless form. Used wherever we are talking to someone who has not signed up. */
export const trialUndated = (days: number): string =>
  `${days}-day trial, nothing to pay for the first ${days} days`;

/** The same, as a sentence that can end a paragraph. */
export const trialUndatedSentence = (days: number): string =>
  `${days}-day trial. Nothing to pay for the first ${days} days.`;

/** A call to action. No "free", and no date, because a public page has none. */
export const trialCta = (days: number): string => `Start your ${days}-day trial`;

/**
 * THE DATED PROMISE, for a garage whose trial exists. Two sentences: what they get, and when the
 * money moves. The date is formatted through the country profile, like every other date we show.
 */
export function trialDated(days: number, endsAt: Date, profile: CountryProfile): string {
  return `Try GreaseDesk for ${days} days. Nothing to pay until ${formatProfileDate(profile, endsAt, { long: true })}.`;
}

/**
 * THE SAME FACT FROM THE OTHER END — the first payment, named, with the way out. Used where the
 * charge is the subject: the onboarding checkout step, the Licence screen, the trial-end email.
 */
export function firstPaymentDated(days: number, endsAt: Date, profile: CountryProfile): string {
  const when = formatProfileDate(profile, endsAt, { long: true });
  return `${days}-day trial: your first payment is on ${when}; cancel before then and you pay nothing.`;
}

/**
 * ── WHAT STRIPE CHECKOUT SHOWS NEXT TO THE BUTTON ──────────────────────────────────────────────
 * `custom_text.submit.message`, the one place on Stripe's page where our own words appear. It is
 * capped at 1200 characters by the API; these are far shorter, and the cap is noted rather than
 * guarded because a plan sentence that approached it would be a different problem.
 *
 * EVERY FIGURE IS PASSED IN, already formatted by the caller through the money chokepoint. This
 * module does no arithmetic on pennies and holds no price: the amounts come from the same resolver
 * the screen quoted, so the page a garage read and the page it pays on cannot disagree.
 *
 * THE RENEWAL FIGURE IS NAMED WHENEVER IT DIFFERS from the first year's. A first-year price shown
 * alone is the mis-sale this whole slice exists to prevent — the garage would learn the real figure
 * from its second invoice.
 */
export function checkoutCustomText(a: {
  plan: 'monthly' | 'annual';
  days: number;
  endsAt: Date;
  profile: CountryProfile;
  /** What the card is charged when the trial ends, formatted. */
  firstChargeLabel: string;
  /** What it renews at, formatted. Null when it is the same as the first charge. */
  renewalLabel: string | null;
}): string {
  const when = formatProfileDate(a.profile, a.endsAt, { long: true });
  const head = `Nothing to pay for ${a.days} days.`;
  const tail = `Cancel before ${when} and you pay nothing.`;
  if (a.plan === 'monthly') {
    return `${head} Then ${a.firstChargeLabel} a month. ${tail}`;
  }
  return a.renewalLabel && a.renewalLabel !== a.firstChargeLabel
    ? `${head} Then ${a.firstChargeLabel} for your first year, renewing at ${a.renewalLabel} a year. ${tail}`
    : `${head} Then ${a.firstChargeLabel} a year. ${tail}`;
}

/**
 * THE NAME ON A FIRST-YEAR COUPON, as it appears on the Stripe invoice and in the dashboard.
 *
 * It was `First year` — true and useless on an invoice line a garage reads next to a number. The
 * name says what the discount is and how much, derived from the amount so a settings change makes
 * a NEW coupon with a NEW name rather than a stale one.
 *
 * EXISTING COUPONS KEEP THEIR IDS AND THEIR NAMES. The id is deterministic from the amount and the
 * currency (lib/billing-plans, firstYearCouponId) and live subscriptions point at it; Stripe will
 * not rename a coupon that exists, and ensureFirstYearCoupon only ever creates a missing one. So
 * this name reaches new coupons only, which is the whole reason the id is derived from the amount.
 */
export const firstYearCouponName = (discountLabel: string): string =>
  `Referral offer: first year ${discountLabel} off`;
