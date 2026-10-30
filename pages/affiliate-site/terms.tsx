/**
 * File: pages/affiliate-site/terms.tsx
 * AFFILIATE TERMS — its own page, on the affiliate site's host, served at /terms by a rewrite.
 *
 * ── A SUMMARY, AND IT SAYS SO ──────────────────────────────────────────────────────────────────
 * The owner's instruction for this slice was that a placeholder link is acceptable for now, and the
 * full document is its own slice. So this page states the terms that ARE settled — the money, the
 * hold, the refund rule, self-referral, notice — and says plainly that the complete document is
 * being finalised. It does not invent an obligation, a liability, a termination right or a
 * jurisdiction clause.
 *
 * ── THE RESELLER SITE DELIBERATELY HAS NO TERMS LINK, AND THIS ONE DOES ────────────────────────
 * On 2026-09-12 the owner ruled that the reseller site must NOT link to its unfinished terms: a
 * partner clicking through to placeholder prose learns something about how ready we are. That
 * ruling stands for that site. This page exists under a different instruction and takes a different
 * approach to the same problem — it is not placeholder about money, which is the part a person
 * actually needs before they decide, and it is explicit about what is still coming.
 *
 * ── A FILE ROUTE, NOT THE CONTENT SYSTEM, for the reason pages/rep-site/terms.tsx records: ─────
 * admitting [slug] to this host's allow-list would expose every published document on it, garage
 * policies included. The cost is the same — changing these words needs a deploy — and the fix is
 * the same: when a document gains an audience or host axis, this becomes a document.
 */
import type { GetServerSideProps } from 'next';
import Seo from '@/components/marketing/Seo';
import AffiliateSiteChrome from '@/components/affiliate-site/AffiliateSiteChrome';
import { COMPANY, AFFILIATE_SITE_URL, absoluteAffiliateSiteUrl } from '@/lib/company-info';

/**
 * THE OG IMAGE IS THE BRAND FILE, not a designed card — and it is this exact path because that is
 * the ONE file outside /affiliate-site that middleware serves on this host (its BRAND_ASSET
 * exact-match). Seo's default would have produced an apex URL, which is the wrong origin for a page
 * on this host; the reseller site has its own og.png because somebody drew one, and this site can
 * have the same the day it is drawn. Capital L: the filename really is greasedesk-Logo.png and the
 * middleware comparison is case-sensitive.
 */
const BRAND_ASSET = '/greasedesk-Logo.png';

type Props = {
  rewardSentence: string;
  totalLabel: string;
  holdDays: number;
  garage: { offerLabel: string; renewalLabel: string; monthsPaid: number; monthsGiven: number };
};

export default function AffiliateTerms({ rewardSentence, totalLabel, holdDays, garage }: Props) {
  // SETTLED and UNSETTLED kept visibly apart, so nobody reads a placeholder as a promise.
  const settled: { heading: string; body: string }[] = [
    { heading: 'What you earn', body: rewardSentence },
    { heading: 'On a yearly payment', body: `If the garage pays for a year up front, the whole ${totalLabel} is earned once that invoice is paid.` },
    { heading: 'What the garage gets', body: `${garage.monthsGiven} months for the price of ${garage.monthsPaid} on their first year — ${garage.offerLabel} instead of ${garage.renewalLabel} — frozen at the day they sign up, whatever we change later.` },
    { heading: 'When it becomes payable', body: `${holdDays} days after the garage's payment clears. Payment is by bank transfer and we need your bank details before anything can be sent; what you have earned waits until they are there.` },
    { heading: 'Refunds', body: 'If we refund a garage’s payment in full, the reward that payment earned is reversed. A partial refund leaves it alone. A reversal is set against what you earn next, and we do not ask for money back.' },
    { heading: 'Garages you own or work for', body: 'You cannot earn on a garage you own, work for, or are part of. This is checked when you sign up and again when a reward would be earned.' },
    { heading: 'Changes to the programme', body: 'We will give you 30 days’ notice before changing what the programme pays. A garage already referred keeps the terms it was referred under.' },
    { heading: 'Tax', body: 'What you earn is yours to declare. We deduct nothing from it and we are not able to advise you about it.' },
  ];
  const coming: string[] = [
    'The full agreement — the definitions, what each side undertakes, liability, data protection and how either side ends it.',
    'What happens to referrals already made if you stop being an affiliate.',
  ];

  return (
    <>
      <Seo
        title="Affiliate terms — GreaseDesk"
        description="What the GreaseDesk affiliate programme pays, when it pays it, and the rules that apply."
        path="/terms"
        origin={AFFILIATE_SITE_URL}
        ogImage={absoluteAffiliateSiteUrl(BRAND_ASSET)}
      />
      <AffiliateSiteChrome>
        <section className="max-w-3xl mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-12">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-ink tracking-tight">Affiliate terms</h1>
          <p className="mt-4 text-sm text-warn" data-testid="terms-draft-note">
            This page states the terms that are settled. The complete agreement is being finalised and
            will be published here before the programme opens.
          </p>

          <div className="mt-8 space-y-6">
            {settled.map((s) => (
              <div key={s.heading}>
                <h2 className="text-base font-semibold text-ink">{s.heading}</h2>
                <p className="mt-1 text-sm text-muted">{s.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 border-t border-line pt-6">
            <h2 className="text-base font-semibold text-ink">Still to come</h2>
            <ul className="mt-2 space-y-2 text-sm text-muted list-disc pl-5">
              {coming.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>

          <p className="mt-10 text-xs text-muted">
            {COMPANY.legalName}, company number {COMPANY.companyNumber}. Questions about the programme:
            call <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline">{COMPANY.phone}</a>.
          </p>
        </section>
      </AffiliateSiteChrome>
    </>
  );
}

/** The same resolvers the home page uses, for the same reason: no figure on this page is typed. */
export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const { prisma } = await import('@/lib/db');
  const { currentTerms, AFFILIATE_HOLD_DAYS } = await import('@/lib/affiliate');
  const { publicPlanChoice } = await import('@/lib/plan-choice');
  const { rewardFigures, rewardSentence } = await import('@/lib/affiliate-public');

  const terms = await currentTerms(prisma);
  const figures = rewardFigures({ totalRewardPennies: terms.totalRewardPennies, instalmentPennies: terms.instalmentPennies });
  const choice = await publicPlanChoice(prisma, { referred: true });

  return {
    props: {
      rewardSentence: rewardSentence(figures),
      totalLabel: figures.totalLabel,
      holdDays: AFFILIATE_HOLD_DAYS,
      garage: {
        offerLabel: choice.annual.totalLabel,
        renewalLabel: choice.annual.renewalTotalLabel,
        monthsPaid: choice.annual.monthsPaid,
        monthsGiven: choice.annual.monthsGiven,
      },
    },
  };
};
