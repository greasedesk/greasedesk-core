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
  const { email } = router.query;
  
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
            Check your inbox
          </h1>
          
          <p className="text-muted text-sm mb-6">
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
          
        </div>
      </div>
      </SiteChrome>
    </>
  );
}