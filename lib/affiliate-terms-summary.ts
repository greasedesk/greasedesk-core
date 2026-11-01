/**
 * File: lib/affiliate-terms-summary.ts
 * THE SETTLED TERMS, IN SUMMARY — the words that stand until the full agreement is published.
 *
 * ── WHY IT LEFT THE PAGE IT WAS WRITTEN ON (owner, 2026-11-01) ──────────────────────────────────
 * This text was inline in pages/affiliate-site/terms.tsx, which was right while exactly one page
 * showed it. The portal now has its own Terms screen behind the sign-in — the owner's instruction
 * was that Terms must open inside the portal with the menu, showing the version they accepted —
 * and the two screens must not be two statements of the same agreement. One of them would be
 * edited and the other would not, and the one somebody quotes back is whichever suits them.
 *
 * That is the same reasoning that put REFUND_RULE in lib/affiliate-portal-copy a day earlier: the
 * promise about refunds was written twice and said two different things, and it took the owner
 * reading his own terms to find it. Written once, read twice.
 *
 * ── A LEAF: NO IMPORTS ──────────────────────────────────────────────────────────────────────────
 * Rendered in the browser on both surfaces. A constant pulled from a module that reaches the
 * database ships Prisma to the browser — lib/affiliate-portal-nav's header carries the measurement.
 *
 * ── NO FIGURE IS TYPED IN HERE ──────────────────────────────────────────────────────────────────
 * Every number arrives as an argument, resolved by the caller from the same resolvers the public
 * pages use (rewardFigures, publicPlanChoice, AFFILIATE_HOLD_DAYS). A pound figure written into
 * this file would be a second source for the reward, and the terms contradicting the programme is
 * the exact failure the content system's baking exists to prevent.
 */

export type TermsSummaryFigures = {
  /** lib/affiliate-public's own sentence about what an introduction pays. Never assembled here. */
  rewardSentence: string;
  /** The total reward, formatted — e.g. '£120'. */
  totalLabel: string;
  /** AFFILIATE_HOLD_DAYS. */
  holdDays: number;
  garage: { offerLabel: string; renewalLabel: string; monthsPaid: number; monthsGiven: number };
};

export type TermsSummarySection = { heading: string; body: string };

/**
 * SAID PLAINLY, AND ON BOTH SURFACES. A summary that did not admit to being one would be read as
 * the agreement — and the full document is with the solicitor, which is a fact about us and not a
 * reason to be vague with somebody deciding whether to join.
 */
export const TERMS_SUMMARY_NOTE = 'This page states the terms that are settled. The complete agreement '
  + 'is being finalised and will be published here before the programme opens.';

/** What the settled summary does NOT yet cover — listed, rather than left to be noticed. */
export const TERMS_SUMMARY_COMING: readonly string[] = [
  'The full agreement — the definitions, what each side undertakes, liability, data protection and how either side ends it.',
  'What happens to referrals already made if you stop being an affiliate.',
];

/**
 * SETTLED and UNSETTLED kept visibly apart, so nobody reads a placeholder as a promise.
 *
 * ── THE REFUND SECTION DOES NOT SAY "we do not ask for money back", WHICH IT DID UNTIL 2026-10-31
 * Terms 6.5 and 6.6 deduct a cancelled reward from the next payout, and section 7 recovers one
 * earned on a garage the affiliate could not earn on. A summary that reassures where the agreement
 * does not is the sentence somebody quotes back on the one day it matters.
 */
export function termsSummary(f: TermsSummaryFigures): TermsSummarySection[] {
  return [
    { heading: 'What you earn', body: f.rewardSentence },
    {
      heading: 'On a yearly payment',
      body: `If the garage pays for a year up front, the whole ${f.totalLabel} is earned once that invoice is paid.`,
    },
    {
      heading: 'What the garage gets',
      body: `${f.garage.monthsGiven} months for the price of ${f.garage.monthsPaid} on their first year — `
        + `${f.garage.offerLabel} instead of ${f.garage.renewalLabel} — frozen at the day they sign up, `
        + 'whatever we change later.',
    },
    {
      heading: 'When it becomes payable',
      body: `${f.holdDays} days after the garage's payment clears. Payment is by bank transfer and we need `
        + 'your bank details before anything can be sent; what you have earned waits until they are there.',
    },
    {
      heading: 'Refunds and chargebacks',
      body: 'If we refund a garage’s payment in full, or its bank reverses it, the reward that payment earned '
        + 'is cancelled; if we have already paid you, it comes off your next payout. A partial refund, such as '
        + 'a goodwill gesture, leaves the reward alone.',
    },
    {
      heading: 'Garages you own or work for',
      body: 'You cannot earn on a garage you own, work for, or are part of. This is checked when you sign up '
        + 'and again when a reward would be earned, and a reward found to have been earned this way is '
        + 'cancelled and recovered.',
    },
    {
      heading: 'Changes to the programme',
      body: 'We will give you 30 days’ notice before changing what the programme pays. A garage already '
        + 'referred keeps the terms it was referred under.',
    },
    {
      heading: 'Labelling your content',
      body: 'UK advertising rules require affiliate content to be labelled as an ad — “#ad” at the start of the '
        + 'post or the description — and we ask everyone to do it. It applies wherever you post: video, text, '
        + 'social or email.',
    },
    {
      heading: 'Tax',
      body: 'What you earn is yours to declare. We deduct nothing from it and we are not able to advise you about it.',
    },
  ];
}
