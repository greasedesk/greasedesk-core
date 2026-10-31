/**
 * File: lib/affiliate-portal-copy.ts
 * THE WORDS ON THE AFFILIATE PORTAL. A leaf — no imports — so the pages, the poster and the email
 * templates read one copy of them and a gate can assert their shape without a browser.
 *
 * ── WHY THE SOCIAL POSTS ARE IN CODE AND NOT IN THE ENGINE ROOM ─────────────────────────────────
 * The videos are operator-editable (a Document, read at request time) because they change and
 * because they are just links. These are not: every one of them carries an ADVERTISING DISCLOSURE,
 * and the whole value of shipping ready-made posts is that an affiliate who copies one cannot
 * publish an undisclosed ad by accident. Put them in an editor and the label becomes something
 * somebody has to remember; leave them here and it is structural, with a gate on it.
 *
 * The same reasoning as the unsubscribe link in lib/notify: a marketing email whose body lacks its
 * link is REFUSED rather than sent. A post without its label is not offered.
 */

/**
 * THE LABEL, AND IT GOES AT THE FRONT.
 *
 * The CAP Code wants a disclosure that is "clearly identifiable" before someone engages with the
 * post — not discoverable after reading it. A hashtag trailing a paragraph is the shape the ASA has
 * repeatedly ruled insufficient, so every post below is built with this first, by one function, and
 * no post is written out with its own label inline where an edit could drop it.
 */
export const AD_LABEL = '#ad';

/** Prepends the label. The ONE place it is attached — see the header. */
const labelled = (body: string): string => `${AD_LABEL} ${body.trim()}`;

export type SocialPost = { id: string; title: string; text: string };

export type PostInputs = {
  referralLink: string;
  /** From the frozen terms or the live setting — the portal passes what the affiliate's own offer is. */
  monthsGiven: number;
  monthsPaid: number;
};

/**
 * THREE POSTS, FOR THREE PLACES SOMEBODY ACTUALLY POSTS. Short for a story caption, medium for a
 * local Facebook group, and one plain-spoken one for a WhatsApp message to a garage they know —
 * which is how most of these introductions will really happen.
 *
 * NO PRICE IS CLAIMED. The offer is expressed in MONTHS ("twelve for the price of eight"), which is
 * what the frozen terms guarantee that garage; a pound figure would be a promise about a price that
 * can legitimately move, and the affiliate would be the one who had made it.
 */
export function socialPosts(i: PostInputs): SocialPost[] {
  const months = `${i.monthsGiven} months for the price of ${i.monthsPaid}`;
  return [
    {
      id: 'short',
      title: 'Short — for a story or a caption',
      text: labelled(
        `Running a garage on paper diaries and WhatsApp? GreaseDesk does job cards, quotes, invoices and `
        + `the diary in one place. Sign up through my link and you get ${months}: ${i.referralLink}`,
      ),
    },
    {
      id: 'group',
      title: 'For a local trade group',
      text: labelled(
        `If you run a garage and you are still writing job cards out by hand, have a look at GreaseDesk. `
        + `It does the diary, job cards, quotes, invoices and MOT reminders, and it is built for independent `
        + `garages rather than main dealers. Through my link a new garage gets ${months}, and I get a small `
        + `thank-you from them if you stay on. Happy to answer questions: ${i.referralLink}`,
      ),
    },
    {
      id: 'direct',
      title: 'A message to a garage you know',
      text: labelled(
        `Thought of you — GreaseDesk is garage software that handles the diary, job cards, quotes and invoices. `
        + `There is a free trial, and if you go through my link you get ${months}. ${i.referralLink}`,
      ),
    },
  ];
}

/**
 * HOW IT WORKS, IN FOUR STEPS. Deliberately about what the AFFILIATE does, not about how our
 * attribution works: "share your link" is an instruction, "a cookie is stashed against your ref
 * code for 90 days" is a description of our plumbing and belongs nowhere near this page.
 *
 * Step 3 names the hold, because the commonest question an affiliate has is why a reward they can
 * see is not yet money — and answering it before they ask is cheaper than answering it afterwards.
 *
 * ── AND IT MUST NOT PROMISE WHAT THE TERMS DO NOT (owner, 2026-10-31) ───────────────────────────
 * Step 3 said the hold meant "we are not asking for money back from you later" and step 4 said
 * "nothing is ever taken back from money we have already sent you". Terms 6.5 and 6.6 say the
 * opposite in the case that matters: a full refund or a chargeback cancels that payment's reward,
 * and if it was already paid it is DEDUCTED FROM THE NEXT PAYOUT. The hold catches most refunds; it
 * does not catch all of them, and a reassurance that only holds most of the time is read as a
 * guarantee on the day it fails.
 *
 * So the deduction is said once, as REFUND_RULE below, and step 4 and the earnings section both
 * render that one string. A promise written twice is a promise that gets corrected once.
 */
/**
 * WHAT HAPPENS WHEN A GARAGE IS REFUNDED, in the affiliate's own terms. Terms 6.5 and 6.6 in one
 * sentence: a full refund or a chargeback cancels the reward that payment earned, and if we have
 * already paid it, the next payout is smaller by that much. A partial refund — a goodwill gesture
 * on an invoice the garage still paid — leaves the reward alone, which is why "in full" is in here
 * and is not a detail to tidy away.
 *
 * ONE STRING, TWO READERS: step 4 of how-it-works and the earnings section. The thing a person is
 * owed money under should not be phrased two ways on one page.
 */
export const REFUND_RULE = 'If a garage is refunded in full, or its bank reverses a payment, the reward it earned is '
  + 'cancelled — and if we have already paid you, it comes off your next payout.';

export type HowStep = { n: number; title: string; body: string };

export function howItWorks(a: { holdDays: number; monthsGiven: number; monthsPaid: number }): HowStep[] {
  return [
    {
      n: 1,
      title: 'Share your link or your code',
      body: 'Anywhere you like — a message, a post, a printed card on the counter. The link carries your code, '
        + 'so a garage that uses it is matched to you automatically.',
    },
    {
      n: 2,
      title: 'The garage signs up and gets a better deal',
      body: `A garage that comes through you gets ${a.monthsGiven} months for the price of ${a.monthsPaid}. `
        + 'That is the offer they see, and it is fixed for them at the moment they sign up.',
    },
    {
      n: 3,
      title: 'You earn as they pay',
      body: `Each time that garage pays us, your reward is added below. It is held for ${a.holdDays} days first, `
        + 'which is long enough for most refunds to show up before we pay you anything.',
    },
    {
      n: 4,
      title: 'We pay you',
      body: 'Once your details are with us, rewards that have passed the hold go out in the next payment run. '
        + REFUND_RULE,
    },
  ];
}

/**
 * WHEN THE MONEY GOES OUT — the owner's own sentence, 2026-10-31, kept verbatim.
 *
 * It is COPY AND NOT A SCHEDULE: nothing in the code reads this to decide a date, and there is no
 * payment run yet to read it (AffiliatePayout is deferred to November with the payout-run screen).
 * When there is, the run's dates must come from the run, and this sentence must then be checked
 * against them rather than left to describe something that moved — a note that describes a fixed
 * state is the trap the board already carries in the owner's words.
 */
export const PAYOUT_CADENCE = 'Paid monthly by bank transfer on the Friday nearest the 15th, for rewards payable by then.';

/**
 * WHAT THE AFFILIATE IS TOLD ABOUT THEIR BANK DETAILS. Three states, because "we hold none" and
 * "you have asked us to change them" and "these are the ones we will pay" are three different
 * situations and only one of them needs anything doing about it.
 */
export const PAYEE_COPY = {
  none: 'We do not have your bank details yet. We need them before we can send you anything.',
  pending: 'Your details are with us and will be checked before the next payment run. '
    + 'We will pay the account we already hold until then.',
  held: 'These are the details we will pay.',
  /** Said on the form itself, because the delay is deliberate and reads as a fault if unexplained. */
  whyChecked: 'Bank details are checked by a person before we use them. Your sign-in is an email link, '
    + 'so anyone who got into your email could otherwise change where your money goes.',
} as const;
