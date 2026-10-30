/**
 * File: lib/affiliate-public.ts
 * THE FIGURES THE PUBLIC AFFILIATE SITE PRINTS, derived from the settings and nothing else.
 *
 * A LEAF MODULE, and that is the point: it imports the money chokepoint and the locale profile and
 * NOTHING ELSE, so it can be read by a page, by the Engine Room and by a gate without dragging a
 * database client anywhere near a browser bundle. lib/affiliate reaches prisma; one module-scope
 * reference to it from a page component ships Prisma to the client and kills every bit of client
 * JavaScript on the page. The reward NUMBERS live there; the way they READ lives here.
 *
 * ── NOTHING HERE IS TYPED (owner's standing rule) ──────────────────────────────────────────────
 * "£30 a month for four paid months, £120 a garage" is three numbers, and only TWO of them are
 * settings: the instalment and the total. The FOUR is arithmetic — total ÷ instalment — so an
 * operator who changes either figure in the Engine Room changes the sentence on the public page,
 * and there is no second place to remember. A literal 4 in the copy would survive the setting
 * changing and would then be a lie on a page we are asking people to trust.
 *
 * ── THE INSTALMENT MAY LEGITIMATELY BE ZERO, AND THAT IS NOT A DIVISION BY ZERO ────────────────
 * refusePlanSetting ACCEPTS zero pennies (billing-plans-gate holds that: zero is a real setting, a
 * programme paying nothing per month). So `paidMonths` is three states, not a number: a count when
 * there are instalments to count, and NULL when the monthly reward does not exist — at which point
 * the page must say what remains true (the single payment on an annual invoice) rather than print
 * "Infinity paid months" or quietly show a 0 that reads as "no reward at all".
 */
import { formatMoney } from '@/lib/format-money';
import { getProfile, DEFAULT_COUNTRY } from '@/lib/locale-profiles';

/** The two settings this derives everything from, named so a caller cannot pass them the wrong way round. */
export type RewardTerms = { totalRewardPennies: number; instalmentPennies: number };

export type RewardFigures = {
  /** Per paid month. Null when there is no monthly instalment at all. */
  instalmentPennies: number | null;
  instalmentLabel: string | null;
  /** The cap: the most one introduction can ever earn. */
  totalPennies: number;
  totalLabel: string;
  /**
   * How many paid months the cap is worth. NULL when there is no instalment — see the header. A
   * caller showing the monthly sentence must check this, not truthiness: zero is also falsy and
   * means something different (a cap of nothing).
   */
  paidMonths: number | null;
  /** Does the monthly half of the programme exist at all? */
  monthlyApplies: boolean;
};

/**
 * Pence only when there are pence — the rule lib/plan-choice already uses for plan prices. £30 must
 * not render "£30.00" beside "£120", and an operator who sets £30.50 must not see "£31".
 */
const money = (pennies: number, country?: string | null): string => {
  const p = getProfile(country ?? DEFAULT_COUNTRY);
  return formatMoney(pennies, {
    currency: p.currency, locale: p.locale,
    maximumFractionDigits: pennies % 100 === 0 ? 0 : 2,
  });
};

export function rewardFigures(terms: RewardTerms, country?: string | null): RewardFigures {
  const total = Math.max(0, Math.trunc(terms.totalRewardPennies));
  const instalment = Math.trunc(terms.instalmentPennies);
  const monthlyApplies = instalment > 0;
  return {
    instalmentPennies: monthlyApplies ? instalment : null,
    instalmentLabel: monthlyApplies ? money(instalment, country) : null,
    totalPennies: total,
    totalLabel: money(total, country),
    // FLOOR, not round: the cap is the cap. At £120 and £50 the honest answer is two full
    // instalments and £20 that the fourth month would have to be short of — and the page says the
    // cap, so a reader is never promised a third £50.
    paidMonths: monthlyApplies ? Math.floor(total / instalment) : null,
    monthlyApplies,
  };
}

/**
 * The one sentence that states the reward, assembled from the figures above.
 *
 * HERE RATHER THAN IN THE PAGE because the Engine Room and the terms document will both need to say
 * the same thing, and a sentence written twice is a sentence that disagrees with itself. The page
 * owns the TONE and the layout; this owns the arithmetic reaching the words.
 */
export function rewardSentence(f: RewardFigures): string {
  if (!f.monthlyApplies || f.paidMonths === null) {
    return `${f.totalLabel} for each garage you introduce, paid once their yearly invoice is paid.`;
  }
  const months = f.paidMonths === 1 ? 'first paid month' : `first ${f.paidMonths} paid months`;
  return `${f.instalmentLabel} for each of a garage's ${months} — ${f.totalLabel} a garage, and ${f.totalLabel} is the most one garage can earn.`;
}
