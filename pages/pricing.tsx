/**
 * File: pages/pricing.tsx
 * Public pricing. Monthly | Yearly, opening on YEARLY, with the figures a visitor would actually
 * be quoted at signup.
 *
 * ── THE FIGURES COME FROM THE SIGNUP RESOLVER (owner, 2026-10-29) ──────────────────────────────
 * Every figure here comes from `publicPlanChoice` — the same resolver, the same arithmetic and the
 * same reads as `/onboarding/billing`. Nothing is typed.
 *
 * WHICH HALF AN OPERATOR CAN MOVE, because it is not obvious and the first draft of this comment
 * had it wrong. The MONTHLY PRICE is not an Engine Room setting: it lives on the country profile
 * in lib/locale-profiles (GB £75) and changing it takes a deploy. `lib/billing-pricing` and
 * `planSettings` both read that same constant, so this page's old £75 and the chooser's £75 were
 * always one number from one place. What the Engine Room owns is the MONTHS —
 * `renewal_annual_months_paid`, `offer_months_paid`, `months_given` — so the yearly price, the
 * monthly equivalent and the saving are all `months × that constant` and all move when an operator
 * saves. That is the half this page could not previously show at all.
 *
 * Going through one resolver still matters, for the reason the saving exists: it is
 * `months_given × monthly − yearly`, and two surfaces each doing that arithmetic their own way is
 * how one of them ends up a deploy behind. `lib/billing-pricing` remains the source for the VAT
 * suffix and for the meta description's single per-month string, which is one figure, not a
 * comparison.
 *
 * ── NO TRIAL-END DATE ON A CACHED PAGE ─────────────────────────────────────────────────────────
 * The resolver's `trialSentence` names the date the trial ends, computed from `Date.now()`. On an
 * ISR page that date is frozen at render and would be quietly wrong for up to the revalidate
 * window — a promise to a prospect, dated, and stale. The public page states the trial LENGTH
 * (a setting) and the prices, and leaves the dated sentence to the signed-in screens where "now"
 * is the request.
 *
 * ── THE REFERRAL CASE, AND WHY IT IS CLIENT-SIDE ───────────────────────────────────────────────
 * This page is cached and shared by every visitor, so it cannot be rendered per-referral. Both
 * figure sets — standard and referred — are in the props, and the client picks: it reads `?ref=`
 * or the consented `gd_ref` cookie, asks /api/affiliate/check-code whether we know the code, and
 * only then swaps. An unknown, suspended or ambiguous code shows the normal prices, which is the
 * safe direction: quoting a discount nobody is entitled to is the one error that costs money.
 *
 * The affiliate's NAME is never shown here. Signed in, a garage is told whose offer it is; on a
 * page anyone can load, that would publish the affiliate list to anyone who guesses a code.
 * `publicPlanChoice` passes `referrerName: null`, so the nameless line is structural rather than
 * something this page has to remember.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { GetStaticProps } from 'next';
import Seo from '@/components/marketing/Seo';
import SiteChrome from '@/components/marketing/SiteChrome';
import { perLocationLabel } from '@/lib/billing-pricing';
// Used ONLY inside getStaticProps, so Next strips it (and lib/db behind it) from the client
// bundle. A module-scope reference here would ship Prisma to the browser and kill all client JS.
import { publicPlanChoice, type PlanChoice } from '@/lib/plan-choice';
// Pure string helpers — no db, safe on both sides.
import { normaliseRefCode, publicReferralSentence } from '@/lib/plan-choice';
// ALIASED, because this page's PROP is also called trialDays. One label, two subjects: the
// client half of the file then reads as a use of the server import, and client-bundle-gate
// correctly cannot tell the difference. The alias is the distinction, not a workaround.
import { trialDays as readTrialDays } from '@/lib/programme-settings';

const Check = () => (
  <svg className="w-5 h-5 text-accent shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const INCLUDED = [
  'Unlimited digital job cards & photos',
  'Bookings diary & customer records',
  'Invoicing with freeze-at-issue accuracy',
  'Live profit-and-loss dashboard',
  'Multi-site ready — add locations any time',
  'Email support',
];

type Props = { trialDays: number; standard: PlanChoice; referred: PlanChoice };

/**
 * WHICH CODE DID THIS VISITOR ARRIVE WITH? The query string first, then the consented cookie —
 * the same order lib/attribution uses at signup, so the page quotes the offer the signup will
 * actually apply. `gd_ref` is an opt-in cookie and is absent unless the visitor consented, which
 * is why the query string has to be read as well and not instead.
 */
function arrivedWithCode(): string | null {
  if (typeof window === 'undefined') return null;
  const fromQuery = new URLSearchParams(window.location.search).get('ref');
  if (fromQuery) return normaliseRefCode(fromQuery);
  const m = document.cookie.match(/(?:^|;\s*)gd_ref=([^;]*)/);
  return m ? normaliseRefCode(decodeURIComponent(m[1])) : null;
}

export default function PricingPage({ trialDays: trial, standard, referred }: Props) {
  // YEARLY BY DEFAULT (owner, 2026-10-29) — the toggle opens on the better price, matching the
  // signup chooser, so a visitor compares on the figure we would rather they chose.
  const [plan, setPlan] = useState<'monthly' | 'annual'>('annual');
  // NULL UNTIL ANSWERED, and null renders the standard prices. Three states, not two: no code,
  // a code we have not asked about yet, and a code we know. The middle one must look like the
  // first — a page that flashed a discount and withdrew it would be worse than never showing it.
  const [refCode, setRefCode] = useState<string | null>(null);

  useEffect(() => {
    const code = arrivedWithCode();
    if (!code) return;
    let live = true;
    // VALIDITY IS THE SERVER'S ANSWER, never the presence of a parameter. Anyone can type
    // ?ref=ANYTHING; only a code we know gets the offer. check-code answers yes/no and NOTHING
    // else — no name, no party type — which is exactly what this page is allowed to know.
    fetch('/api/affiliate/check-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    })
      .then((r) => r.json())
      .then((d) => { if (live && d?.ok === true) setRefCode(code); })
      // A FAILED LOOKUP SHOWS THE NORMAL PRICES. Quoting a discount because the check did not
      // answer is the one failure direction that costs money.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const choice = refCode ? referred : standard;
  const a = choice.annual;
  const m = choice.monthly;
  const shown = plan === 'annual' ? a : m;

  return (
    <>
      <Seo
        title="Pricing — GreaseDesk garage management software"
        description={`Simple, flat pricing: ${perLocationLabel()} per site, per month. No tiers, no setup fees, cancel any time. Start a ${trial}-day free trial.`}
        path="/pricing"
        softwareApp
        trialDays={trial}
      />
      <SiteChrome>
        <section className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-8 text-center">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-ink tracking-tight">Simple, flat pricing</h1>
          <p className="mt-4 text-lg text-muted">One price per site. No tiers, no setup fees, cancel any time.</p>
        </section>

        <section className="max-w-md mx-auto px-4 sm:px-6 lg:px-8 pb-16">
          <div className="bg-surface border border-line rounded-2xl p-8 shadow-card text-center" data-testid="public-plan-panel">
            {/* THE TOGGLE. Two buttons rather than a select: it is a comparison, and both options
                should be readable without opening anything. aria-pressed carries the state for a
                screen reader and for a clause that needs to know which one is chosen. */}
            <div className="inline-flex rounded-lg border border-line p-1 bg-surface-muted" role="group" aria-label="Billing period">
              {(['monthly', 'annual'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setPlan(k)}
                  aria-pressed={plan === k}
                  data-testid={`public-toggle-${k}`}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    plan === k ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'
                  }`}
                >
                  {k === 'monthly' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>

            {/* THE HEADLINE IS ALWAYS A MONTHLY EQUIVALENT, on both plans — that is the only way
                the two compare. The yearly charge is stated directly beneath, so the equivalence
                is never mistaken for what leaves the bank. */}
            <div className="mt-6 flex items-baseline justify-center gap-1">
              <span className="text-5xl font-extrabold text-ink tabular-nums" data-testid="public-headline">
                {shown.perMonthEquivLabel}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">per site, per month</p>

            {plan === 'annual' ? (
              <>
                <p className="mt-2 text-sm text-ink" data-testid="public-annual-billed">
                  {a.offerApplies
                    ? `Billed ${a.perLocationLabel} for your first year, then ${a.renewalPerLocationLabel} a year.`
                    : `Billed ${a.renewalPerLocationLabel} a year, per site.`}
                </p>
                {a.savingLabel && a.savingPercentLabel && (
                  <p className="mt-2 inline-block rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent" data-testid="public-saving">
                    {`${a.savingLabel} · ${a.savingPercentLabel}`}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-ink" data-testid="public-monthly-billed">
                {`Billed ${m.perLocationLabel} a month, per site.`}
              </p>
            )}

            {/* THE REFERRAL LINE. By CODE, never by the affiliate's name — see the header. */}
            {refCode && (
              <p className="mt-4 rounded-lg bg-surface-muted border border-line px-3 py-2 text-sm text-ink" data-testid="public-referral">
                {publicReferralSentence(refCode, a.monthsGiven, a.monthsPaid)}
              </p>
            )}

            <Link href="/register" className="mt-6 inline-block w-full bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-6 py-3.5 text-base transition-colors">
              Start your {trial}-day free trial
            </Link>
            <p className="mt-2 text-xs text-muted">Payment card required. Cancel any time.</p>

            <ul className="mt-8 space-y-3 text-left">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-ink">
                  <Check /><span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-6 text-center text-sm text-muted">
            Questions about a bigger workshop? <Link href="/contact" className="text-accent hover:underline">Talk to us</Link>.
          </p>
        </section>
      </SiteChrome>
    </>
  );
}

// ── STATICALLY GENERATED, REFRESHED ON DEMAND, AND SELF-HEALING IN A MINUTE ──────────────────
// The trial length is a setting (lib/programme-settings), and this page prints it. Saving in the
// Engine Room calls res.revalidate('/en-GB/pricing') — the LOCALE-PREFIXED path, which is the
// prerendered route key; `/pricing` addresses a page that is not the one in the cache, and the hour
// greasedesk.com spent promising the wrong number on 2026-10-25 is what that cost.
//
// WAS 3600. An hour is the right backstop only if the on-demand path is trustworthy, and it was
// not: the save reported success and nothing happened, so the backstop WAS the mechanism and
// nobody knew. Sixty seconds bounds the worst case to something nobody is harmed by, and the save
// now reads this page back rather than believing the refresher.
export const getStaticProps: GetStaticProps<Props> = async () => {
  // A BLOCK BODY, not `=> ({ … })`. client-bundle-gate models tree-shaking by cutting the BRACED
  // body of each server data function; an expression-bodied arrow has no braced body, so the
  // import stays visible in the page's client half and reads as a leak. The gate is blind to that
  // shape — written up for its own fix — and in the meantime this is the form every other page
  // in the codebase already uses.
  // BOTH FIGURE SETS, because the page is cached and the referral case cannot be rendered per
  // visitor. `referred: true` is not a claim about THIS visitor — it is the price a referred one
  // would be quoted, and the client shows it only after check-code says the code is ours.
  //
  // TWO CALLS, ONE SETTINGS ROW EACH. They could share a read; they deliberately do not, because
  // publicPlanChoice is the same entry point the signed-in path uses and giving the page its own
  // cheaper route is how a second copy of this arithmetic starts. Twice per revalidate window is
  // not a cost worth a shortcut.
  const [trialDays, standard, referred] = await Promise.all([
    readTrialDays(),
    publicPlanChoice(undefined, { referred: false }),
    publicPlanChoice(undefined, { referred: true }),
  ]);
  return { props: { trialDays, standard, referred }, revalidate: 60 };
};
