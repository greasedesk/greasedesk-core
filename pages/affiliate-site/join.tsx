/**
 * File: pages/affiliate-site/join.tsx
 * WHERE THE JOIN BUTTON GOES — a stub, until the signup slice replaces its body.
 *
 * ── WHY IT EXISTS NOW ───────────────────────────────────────────────────────────────────────────
 * The home page's button is live whenever the owner turns `affiliate_joining_open` on, and a button
 * pointing at a 404 is worse than no button. The signup itself — the form, the email check, the SMS
 * code, the code and QR at the end — is its own slice; this page is the honest thing to serve in the
 * meantime, and it tells the truth rather than pretending the door is open.
 *
 * It deliberately offers the SAME waiting list as the closed home page, so a person who got this far
 * does not leave with nothing. When signup ships, the body is replaced and this comment goes with it.
 */
import type { GetServerSideProps } from 'next';
import Seo from '@/components/marketing/Seo';
import AffiliateSiteChrome from '@/components/affiliate-site/AffiliateSiteChrome';
import { AFFILIATE_SITE_URL, absoluteAffiliateSiteUrl } from '@/lib/company-info';

const BRAND_ASSET = '/greasedesk-Logo.png'; // the one file outside /affiliate-site this host serves

export default function AffiliateJoin({ joiningOpen }: { joiningOpen: boolean }) {
  return (
    <>
      <Seo
        title="Become a GreaseDesk affiliate"
        description="Sign up to the GreaseDesk affiliate programme."
        path="/affiliate-site/join"
        origin={AFFILIATE_SITE_URL}
        ogImage={absoluteAffiliateSiteUrl(BRAND_ASSET)}
      />
      <AffiliateSiteChrome>
        <section className="max-w-2xl mx-auto px-4 sm:px-6 pt-12 sm:pt-16 pb-16">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-ink tracking-tight" data-testid="join-stub">
            Signing up isn’t quite ready
          </h1>
          <p className="mt-4 text-sm text-muted">
            We’re finishing the signup form — your details, a code to your mobile, and your referral
            code at the end of it. {joiningOpen
              ? 'The programme is open; this is the last part being built.'
              : 'The programme isn’t open to new affiliates yet either.'}
          </p>
          <p className="mt-4 text-sm text-muted">
            Leave your email on the <a href="/" className="text-accent hover:underline">front page</a> and
            we’ll tell you the moment it’s live. Everything the programme pays is set out there, and on
            the <a href="/terms" className="text-accent hover:underline">terms</a> page.
          </p>
        </section>
      </AffiliateSiteChrome>
    </>
  );
}

/** The switch is read only to say the right sentence — this page serves either way, because the
 *  button that reaches it is what the switch controls. */
export const getServerSideProps: GetServerSideProps<{ joiningOpen: boolean }> = async () => {
  const { prisma } = await import('@/lib/db');
  const { currentTerms } = await import('@/lib/affiliate');
  const terms = await currentTerms(prisma);
  return { props: { joiningOpen: terms.joiningOpen } };
};
