/**
 * File: pages/onboarding/check-email.tsx
 * Last edited: 2025-11-02 at 20:45
 *
 * SaaS Onboarding Step 2: "Check Your Email" page.
 * This page is shown after a new garage owner registers.
 */

import { useRouter } from 'next/router';
import Head from 'next/head';
import SiteChrome from '@/components/marketing/SiteChrome';
import Link from 'next/link';
import { COMPANY } from '@/lib/company-info';

// Simple SVG icon for the email
const EmailIcon = () => (
  <svg
    className="w-16 h-16 text-accent mx-auto"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
    />
  </svg>
);

export default function CheckEmailPage() {
  const router = useRouter();
  // Get the email address from the URL query string
  const { email, verify } = router.query;
  /**
   * ── THIS PAGE USED TO CLAIM SOMETHING IT COULD NOT KNOW (owner, 2026-11-01) ──────────────────
   * Every word of it said "we've sent a verification link to …". The send happens AFTER the garage
   * is committed and can fail on its own — a provider outage, a token insert that threw — and the
   * endpoint now answers 201 in that case rather than reporting a failure for an account that
   * exists. So it also says WHICH of the two happened, and this page reads it.
   *
   * `verify=0` is the only thing it looks for: absent means sent, which keeps every existing link
   * into this page (and anybody's bookmark) reading exactly as it did. Anyone can of course add
   * `&verify=0` to the URL themselves; all that shows them is a phone number that is on every page
   * of the site already.
   */
  const sent = verify !== '0';
  
  return (
    <>
      <Head>
        <title>Check Your Email - GreaseDesk</title>
      </Head>
      <SiteChrome>
      <div className="max-w-md mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-16">
        <div className="bg-surface border border-line rounded-2xl shadow-card p-8 text-center">
          
          <EmailIcon />

          <h1 className="text-xl font-semibold text-ink mt-6 mb-4">
            {sent ? 'Check your inbox' : 'Your account is created'}
          </h1>

          {sent ? (
            <>
              <p data-testid="check-email-sent" className="text-muted text-sm mb-6">
                We've sent a verification link to
                <strong className="text-ink block mt-1">{email || 'your email address'}</strong>
                Please click the link in the email to activate your account and continue to the next step.
              </p>

              <div className="text-xs text-muted">
                Didn't receive it? Please check your spam folder.
                <br />
                <Link href="/register" className="text-muted hover:text-accent underline mt-2 inline-block">
                  Or, try registering again.
                </Link>
              </div>
            </>
          ) : (
            /* THE ACCOUNT IS REAL AND THE EMAIL IS NOT COMING. Both facts, in that order, because
               the first is the one they need to be sure of — and NO "try registering again" here:
               the address is taken now, by them, so that advice leads straight to a refusal. */
            <>
              <p data-testid="check-email-not-sent" className="text-muted text-sm mb-6">
                Your account is set up for
                <strong className="text-ink block mt-1">{email || 'your email address'}</strong>
                We could not send your verification email just now, so there is nothing to click yet.
                Call us on{' '}
                <a href={`tel:${COMPANY.phoneE164}`} className="text-accent hover:underline font-semibold">
                  {COMPANY.phone}
                </a>{' '}
                and we will verify it for you.
              </p>

              <div className="text-xs text-muted">
                Nothing is lost — your details are saved. Please don't register again.
              </div>
            </>
          )}
          
        </div>
      </div>
      </SiteChrome>
    </>
  );
}