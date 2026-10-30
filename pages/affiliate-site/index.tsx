/**
 * File: pages/affiliate-site/index.tsx
 * THE PUBLIC AFFILIATE SITE, at the root of affiliates.greasedesk.com (middleware rewrites '/' here).
 *
 * ── SERVER-RENDERED, WITH NO ISR (owner, 2026-10-30) ───────────────────────────────────────────
 * Deliberate, and the reason the joining switch needs no revalidation: turning
 * `affiliate_joining_open` off in the Engine Room closes signups on the NEXT REQUEST. A statically
 * generated page would keep offering the door for up to its revalidate window after the programme
 * had been closed, and nothing on the page would show that. Said in three places — here, the column
 * comment, and lib/programme-settings' registry note — because the day someone makes this static to
 * save a database read, the switch silently stops meaning what it says.
 *
 * ── EVERY FIGURE COMES FROM THE SETTINGS ───────────────────────────────────────────────────────
 * The reward, the cap, how many paid months the cap is worth, the garage's offer, the trial length
 * and the hold are all props. Nothing in COPY below contains a number that money depends on: the
 * sentences take them as arguments. An operator editing the programme in the Engine Room changes
 * this page, and there is no second place to remember.
 *
 * ── THE COPY IS PLACEHOLDER UNTIL THE OWNER EDITS IT (2026-10-30) ──────────────────────────────
 * Written for two audiences in one page — garage trade and content creators — because they want the
 * same programme explained from two starting points, and two pages would be two sets of words to
 * keep in step. British English, plain, no hype, no invented numbers, no testimonials, no claims
 * about how many garages anybody has. The owner has it in front of him to edit; when he does, this
 * paragraph says "the owner's copy, verbatim" and the words stop being mine.
 *
 * ── MOBILE FIRST ───────────────────────────────────────────────────────────────────────────────
 * Opened from a phone, from a link in a video description. Base classes are the phone.
 */
import { useState } from 'react';
import type { GetServerSideProps } from 'next';
import Seo from '@/components/marketing/Seo';
import AffiliateSiteChrome from '@/components/affiliate-site/AffiliateSiteChrome';
import { AFFILIATE_SITE_URL, absoluteAffiliateSiteUrl } from '@/lib/company-info';
import { WAITLIST_LIMITS, WAITLIST_AUDIENCES, type WaitlistAudience } from '@/lib/affiliate-waitlist';

const input = 'w-full p-3 bg-surface border border-line rounded-lg text-ink text-base focus:ring-2 focus:ring-accent focus:border-accent outline-none';

/** The ONE file outside /affiliate-site this host serves (middleware's exact-match brand asset), so
 *  it is the only image an OG tag here can point at without 404ing. Capital L, deliberately. */
const BRAND_ASSET = '/greasedesk-Logo.png';

const Check = () => (
  <svg className="w-5 h-5 text-accent shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

type Props = {
  joiningOpen: boolean;
  /** The reward, already formatted — see lib/affiliate-public. */
  reward: { sentence: string; totalLabel: string; instalmentLabel: string | null; paidMonths: number | null; monthlyApplies: boolean };
  /** What the garage gets, from the SAME resolver the signup chooser and /pricing use. */
  garage: { offerLabel: string; renewalLabel: string; monthsPaid: number; monthsGiven: number };
  trialDays: number;
  holdDays: number;
};

/**
 * THE WORDS. Functions where a number belongs, plain strings where none does — so a figure can only
 * ever arrive from the props, and a reader editing the copy cannot accidentally fix a price in place.
 */
const COPY = {
  hero: 'Get paid for introducing garages to GreaseDesk.',
  sub: 'GreaseDesk is workshop software for independent garages — job cards, the diary, invoicing, MOT reminders. Introduce one, and you earn on each of their first few paid months. The garage gets a better first year than they could get on their own.',

  earnTitle: 'What you earn, in full',
  earnAnnual: (total: string) =>
    `If the garage pays for a whole year up front, you get the ${total} in one payment, once that invoice is paid.`,
  earnGarage: (given: number, paid: number, offer: string, renewal: string) =>
    `What the garage gets: ${given} months for the price of ${paid} — ${offer} for their first year instead of ${renewal}.`,
  earnWhen: (days: number) =>
    `When: ${days} days after each of their payments clears, by bank transfer. The wait is so a refund has time to appear.`,
  earnRefund:
    'If we refund a garage’s payment in full, the reward that payment earned is reversed. A partial refund — a few pounds back as goodwill — leaves it alone.',
  earnNoLimit: 'There is no limit on how many garages you introduce. The cap is per garage, not per person.',
  earnNotYours: 'You can’t earn on a garage you own or work for. An introduction to yourself isn’t one.',

  whoTitle: 'Who this is for',
  trade: {
    title: 'If you’re already in and out of garages',
    body: 'Tool van, motor factor, parts delivery, diagnostics, calibration, training — you already talk to the person who makes this decision. There’s nothing to carry, nothing to install and no visits to log. You make the introduction; we do the setup, the support and the billing.',
    points: (trialDays: number) => [
      'No stock, no demo kit, no territory.',
      'No targets and nothing to chase — you’re paid on what the garage pays us.',
      `You’re not selling it on your own: the garage has ${trialDays} days with nothing to pay before any money changes hands.`,
    ],
  },
  creator: {
    title: 'If you make videos or write for the trade',
    body: 'Your audience is standing in a workshop. A code and a link are all you need, and you can state the offer in plain numbers — what the garage pays, what they get, what you earn — without clearing it with us first.',
    points: [
      'One code and one link, both of which work on the price page and at signup.',
      'The offer is checkable: a viewer who types your code sees it named on our price page, with the figures.',
      'If you’d rather look at it properly before you mention it, say so and we’ll show you the real thing.',
    ],
  },

  howTitle: 'How it works',
  how: (p: Props) => [
    {
      title: 'Sign up',
      body: 'Your name, your email and your mobile. We send a code to the mobile to check it’s yours. It takes a couple of minutes and there’s nothing to approve.',
    },
    {
      title: 'Share your code or your link',
      body: 'You get both, and a QR code you can print. The code works on our price page and at signup; the link carries it for them.',
    },
    {
      title: 'The garage signs up',
      body: `They get ${p.garage.monthsGiven} months for the price of ${p.garage.monthsPaid} on their first year — ${p.garage.offerLabel} instead of ${p.garage.renewalLabel}. Your code is recorded against them when they sign up.`,
    },
    {
      title: 'You get paid',
      body: p.reward.monthlyApplies && p.reward.paidMonths !== null
        ? `${p.reward.instalmentLabel} for each of their first ${p.reward.paidMonths} paid months, ${p.holdDays} days after each payment clears, by bank transfer.`
        : `${p.reward.totalLabel} once their yearly invoice is paid, ${p.holdDays} days after it clears, by bank transfer.`,
    },
  ],

  faqTitle: 'Questions',
  faq: (p: Props) => [
    {
      q: 'Do I have to be in the motor trade?',
      a: 'No. If you can introduce a garage, you can be an affiliate.',
    },
    {
      q: 'How many garages can I introduce?',
      a: `As many as you like. The ${p.reward.totalLabel} is the cap for one garage, not for you.`,
    },
    {
      q: 'What if the garage leaves after a couple of months?',
      a: 'You keep what those months earned. There’s nothing to pay back, and nothing further is earned once they stop paying.',
    },
    {
      q: 'What if the garage gets a refund?',
      a: 'A full refund of a payment reverses what that payment earned. A partial refund leaves it alone.',
    },
    {
      q: 'When do I actually get the money?',
      a: `${p.holdDays} days after each of their payments clears, by bank transfer. We need your bank details before anything can be sent — you can add them whenever you like, and what you’ve earned waits for them. The first payouts are in December 2026.`,
    },
    {
      q: 'Can I introduce my own garage, or the one I work for?',
      a: 'No. The reward is for an introduction, and that isn’t one.',
    },
    {
      q: 'What about tax?',
      a: 'What you earn is yours to declare. We don’t deduct anything from it, and we can’t advise you on it.',
    },
    {
      q: 'Can I talk about the offer in a video?',
      a: 'Yes, and you can quote the figures on this page as they stand. If we change the programme we’ll tell you 30 days before it changes.',
    },
    {
      q: 'Is this the same as being a reseller?',
      a: 'No. A reseller visits garages on a round, logs the visits and invoices us every month. An affiliate makes an introduction and nothing else. The reseller programme is at reps.greasedesk.com.',
    },
  ],

  joinCta: 'Become an affiliate',
  joinNote: 'Two minutes, and you’ll have your code at the end of it.',

  // THE SWITCH IS OFF. The page still says everything — the terms, the steps, the questions — and
  // only the door changes, because somebody who reads all this and wants in should not have to come
  // back and read it again to find out whether they can.
  closedTitle: 'Opening soon',
  closedBody: 'Leave your email and we’ll tell you when it opens.',
  closedCta: 'Tell me when it opens',
  closedThanks: 'Thanks — we’ll email you when it opens.',
  closedWho: 'Which are you? (optional)',
};

const AUDIENCE_LABEL: Record<WaitlistAudience, string> = {
  trade: 'In the motor trade',
  creator: 'I make content',
};

export default function AffiliateSite(props: Props) {
  const { joiningOpen, reward, garage, trialDays, holdDays } = props;
  const [email, setEmail] = useState('');
  const [audience, setAudience] = useState<'' | WaitlistAudience>('');
  const [website, setWebsite] = useState(''); // honeypot
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  async function joinWaitlist(e: React.FormEvent) {
    e.preventDefault();
    setState('sending'); setMsg(null);
    try {
      const res = await fetch('/api/affiliate-site/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, audience: audience || null, website }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) { setState('sent'); setMsg(data.message || COPY.closedThanks); setEmail(''); }
      else { setState('error'); setMsg(data?.message || 'Something went wrong. Please try again.'); }
    } catch {
      setState('error'); setMsg('We couldn’t reach the server. Please try again shortly.');
    }
  }

  return (
    <>
      <Seo
        title="Become a GreaseDesk affiliate"
        description="Introduce an independent garage to GreaseDesk and earn on their first paid months. The garage gets a better first year. No stock, no visits, no targets."
        path="/"
        origin={AFFILIATE_SITE_URL}
        ogImage={absoluteAffiliateSiteUrl(BRAND_ASSET)}
      />
      <AffiliateSiteChrome>
        {/* ── HERO ─────────────────────────────────────────────────────────────────────────── */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 pt-10 sm:pt-16 pb-10">
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-ink tracking-tight">{COPY.hero}</h1>
          <p className="mt-4 text-base sm:text-lg text-muted">{COPY.sub}</p>
          <p className="mt-4 text-base text-ink font-medium" data-testid="reward-sentence">{reward.sentence}</p>
          <a href="#join" className="mt-6 inline-block w-full sm:w-auto text-center bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
            {joiningOpen ? COPY.joinCta : COPY.closedCta}
          </a>
        </section>

        {/* ── THE TERMS, UP FRONT. Not at the bottom, and not behind a link: the money is the ──
            reason anybody is reading, and burying it is how a programme reads like a trick. */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-12">
          <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6 shadow-card" data-testid="terms-card">
            <h2 className="text-lg font-semibold text-ink">{COPY.earnTitle}</h2>
            <ul className="mt-4 space-y-3 text-sm text-ink">
              <li className="flex items-start gap-3"><Check /><span>{reward.sentence}</span></li>
              <li className="flex items-start gap-3"><Check /><span>{COPY.earnAnnual(reward.totalLabel)}</span></li>
              <li className="flex items-start gap-3"><Check /><span data-testid="garage-offer">{COPY.earnGarage(garage.monthsGiven, garage.monthsPaid, garage.offerLabel, garage.renewalLabel)}</span></li>
              <li className="flex items-start gap-3"><Check /><span data-testid="hold-line">{COPY.earnWhen(holdDays)}</span></li>
              <li className="flex items-start gap-3"><Check /><span>{COPY.earnRefund}</span></li>
              <li className="flex items-start gap-3"><Check /><span>{COPY.earnNoLimit}</span></li>
              <li className="flex items-start gap-3"><Check /><span>{COPY.earnNotYours}</span></li>
            </ul>
            <p className="mt-4 text-xs text-muted">
              The full terms are on the <a href="/terms" className="text-accent hover:underline">affiliate terms</a> page.
            </p>
          </div>
        </section>

        {/* ── WHO IT IS FOR: two audiences, one programme ───────────────────────────────────── */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-12">
          <h2 className="text-lg font-semibold text-ink">{COPY.whoTitle}</h2>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div className="bg-surface border border-line rounded-2xl p-5" data-testid="audience-trade">
              <h3 className="font-semibold text-ink">{COPY.trade.title}</h3>
              <p className="mt-2 text-sm text-muted">{COPY.trade.body}</p>
              <ul className="mt-3 space-y-2 text-sm text-ink">
                {COPY.trade.points(trialDays).map((s) => <li key={s} className="flex items-start gap-3"><Check /><span>{s}</span></li>)}
              </ul>
            </div>
            <div className="bg-surface border border-line rounded-2xl p-5" data-testid="audience-creator">
              <h3 className="font-semibold text-ink">{COPY.creator.title}</h3>
              <p className="mt-2 text-sm text-muted">{COPY.creator.body}</p>
              <ul className="mt-3 space-y-2 text-sm text-ink">
                {COPY.creator.points.map((s) => <li key={s} className="flex items-start gap-3"><Check /><span>{s}</span></li>)}
              </ul>
            </div>
          </div>
        </section>

        {/* ── FOUR STEPS ───────────────────────────────────────────────────────────────────── */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-12">
          <h2 className="text-lg font-semibold text-ink">{COPY.howTitle}</h2>
          <ol className="mt-4 space-y-4 text-sm text-ink" data-testid="how-steps">
            {COPY.how(props).map((step, i) => (
              <li key={step.title} className="flex items-start gap-3">
                <span className="font-semibold text-accent shrink-0">{i + 1}.</span>
                <span><span className="font-medium text-ink">{step.title}</span><br />{step.body}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────────────────────────────── */}
        <section className="max-w-4xl mx-auto px-4 sm:px-6 pb-12">
          <h2 className="text-lg font-semibold text-ink">{COPY.faqTitle}</h2>
          <dl className="mt-4 space-y-4" data-testid="faq">
            {COPY.faq(props).map((item) => (
              <div key={item.q} className="border-b border-line pb-4 last:border-0">
                <dt className="text-sm font-medium text-ink">{item.q}</dt>
                <dd className="mt-1 text-sm text-muted">{item.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ── THE DOOR. The only part of the page the switch changes. ──────────────────────── */}
        <section id="join" className="max-w-4xl mx-auto px-4 sm:px-6 pb-16">
          <div className="bg-surface border border-line rounded-2xl p-5 sm:p-6 shadow-card">
            {joiningOpen ? (
              <div className="text-center">
                <a href="/affiliate-site/join" data-testid="join-open"
                  className="inline-block w-full sm:w-auto text-center bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
                  {COPY.joinCta}
                </a>
                <p className="mt-3 text-xs text-muted">{COPY.joinNote}</p>
              </div>
            ) : state === 'sent' ? (
              <div className="text-center py-6" data-testid="waitlist-thanks">
                <div className="text-3xl mb-2" aria-hidden="true">✅</div>
                <p className="text-ink font-medium">{msg}</p>
              </div>
            ) : (
              <form onSubmit={joinWaitlist} className="space-y-4" noValidate data-testid="waitlist-form">
                <div>
                  <h2 className="text-lg font-semibold text-ink">{COPY.closedTitle}</h2>
                  <p className="mt-1 text-sm text-muted">{COPY.closedBody}</p>
                </div>
                <div>
                  <label htmlFor="w-email" className="block text-sm text-muted mb-1">Email</label>
                  <input id="w-email" data-testid="waitlist-email" type="email" required inputMode="email" autoComplete="email"
                    maxLength={WAITLIST_LIMITS.email} className={input} value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <fieldset>
                  <legend className="block text-sm text-muted mb-1">{COPY.closedWho}</legend>
                  <div className="flex flex-wrap gap-3">
                    {WAITLIST_AUDIENCES.map((a) => (
                      <label key={a} className="flex items-center gap-2 text-sm text-ink">
                        <input type="radio" name="audience" value={a} checked={audience === a}
                          data-testid={`waitlist-audience-${a}`}
                          onChange={() => setAudience(a)} className="h-4 w-4 accent-accent" />
                        {AUDIENCE_LABEL[a]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {/* Honeypot: a real person never fills a hidden field. */}
                <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website}
                  onChange={(e) => setWebsite(e.target.value)} className="hidden" />
                {state === 'error' && msg && <p data-testid="waitlist-error" className="text-sm text-danger">{msg}</p>}
                <button type="submit" data-testid="waitlist-submit" disabled={state === 'sending'}
                  className="w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors disabled:opacity-60">
                  {state === 'sending' ? 'Sending…' : COPY.closedCta}
                </button>
              </form>
            )}
          </div>
        </section>
      </AffiliateSiteChrome>
    </>
  );
}

/**
 * EVERY NUMBER ON THE PAGE, RESOLVED HERE, ON EVERY REQUEST.
 *
 * The imports are dynamic and inside this function on purpose: lib/affiliate and lib/plan-choice
 * both reach prisma, and a module-scope import of either from a page would put the Prisma client in
 * the client bundle — which does not merely bloat it, it throws on load and takes every bit of
 * client JavaScript on the page with it. The same arrangement pages/rep-site/index.tsx uses.
 *
 * `referred: true` on publicPlanChoice is what makes the garage's figures the OFFER figures (12 for
 * 8) rather than the list price — the same resolver the signup chooser and /pricing read, so this
 * page cannot quote an offer the garage would not actually get.
 */
export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const { prisma } = await import('@/lib/db');
  const { currentTerms, AFFILIATE_HOLD_DAYS } = await import('@/lib/affiliate');
  const { publicPlanChoice } = await import('@/lib/plan-choice');
  const { rewardFigures, rewardSentence } = await import('@/lib/affiliate-public');
  const { trialDays } = await import('@/lib/programme-settings');

  const terms = await currentTerms(prisma);
  const figures = rewardFigures(
    { totalRewardPennies: terms.totalRewardPennies, instalmentPennies: terms.instalmentPennies },
  );
  const choice = await publicPlanChoice(prisma, { referred: true });

  return {
    props: {
      joiningOpen: terms.joiningOpen,
      reward: {
        sentence: rewardSentence(figures),
        totalLabel: figures.totalLabel,
        instalmentLabel: figures.instalmentLabel,
        paidMonths: figures.paidMonths,
        monthlyApplies: figures.monthlyApplies,
      },
      garage: {
        offerLabel: choice.annual.totalLabel,
        renewalLabel: choice.annual.renewalTotalLabel,
        monthsPaid: choice.annual.monthsPaid,
        monthsGiven: choice.annual.monthsGiven,
      },
      trialDays: await trialDays(prisma),
      holdDays: AFFILIATE_HOLD_DAYS,
    },
  };
};
