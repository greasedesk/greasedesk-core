/**
 * File: pages/onboarding/billing.tsx
 * Last edited: 2025-11-18 11:40 Europe/London
 *
 * Billing step – fully client-side, with safe useSession handling.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useSession, signIn } from 'next-auth/react';

// Simple SVG icon for the credit card
const CreditCardIcon = () => (
  <svg
    className="w-16 h-16 text-blue-400 mx-auto"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H4a3 3 0 00-3 3v8a3 3 0 003 3z"
    />
  </svg>
);

// Simple SVG for the loading spinner
const LoadingSpinner = () => (
  <svg
    className="animate-spin h-5 w-5 text-white"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    />
  </svg>
);

export default function BillingPage() {
  const router = useRouter();

  // SAFE useSession usage – guards against undefined return value
  const sessionResult = useSession();
  const { data: session, status } =
    sessionResult ?? ({ data: null, status: 'loading' } as const);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Trigger sign-in redirect only as an effect (no side effects in render)
  useEffect(() => {
    if (status === 'unauthenticated') {
      signIn('credentials', { callbackUrl: '/onboarding/billing' });
    }
  }, [status]);

  // --- Billing logic ---
  const handleStartTrial = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/onboarding/create-billing', {
        method: 'POST',
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          data?.message ||
            'Could not start your trial. Please contact support.'
        );
      }

      // Success – go to the next onboarding step
      router.push('/onboarding/setup');
    } catch (err: any) {
      setError(err.message || 'Unexpected error starting your trial.');
    } finally {
      setLoading(false);
    }
  };

  // --- Page Security / loading states ---
  if (status === 'loading' || !sessionResult) {
    return (
      <main className="min-h-screen bg-slate-900 flex items-center justify-center">
        <LoadingSpinner />
      </main>
    );
  }

  if (status === 'unauthenticated') {
    // Brief placeholder while signIn redirect runs
    return (
      <main className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-100">
        Redirecting you to sign in…
      </main>
    );
  }

  // --- Render Page ---
  return (
    <>
      <Head>
        <title>Start Your Trial - Billing - GreaseDesk</title>
      </Head>
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-800/80 border border-slate-700 rounded-2xl shadow-xl p-8">
          <CreditCardIcon />

          <h1 className="text-xl font-semibold text-white mt-6 mb-4 text-center">
            Start Your Free Trial
          </h1>

          <p className="text-slate-400 text-sm mb-6 text-center">
            Your account is verified. To activate your 60-day free trial and
            secure your pricing, please enter your payment details.
          </p>

          <div className="bg-slate-700/50 p-4 rounded-lg mb-6">
            <p className="text-xs text-green-300 font-semibold mb-2">
              Policy on Billing:
            </p>
            <ul className="text-xs text-slate-300 list-disc list-inside space-y-1 text-left">
              <li>Start your 60-day free trial today with no commitment.</li>
              <li>We will arrange a quick meeting within the first 30 days.</li>
              <li>
                Your paid plan begins after 60 days unless you cancel before the
                trial ends.
              </li>
            </ul>
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-red-800 border border-red-600 text-red-200 p-3 rounded-lg text-center mb-4">
              <p className="font-semibold">Error</p>
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* “Fake” Billing Form */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">
                Card Number
              </label>
              <input
                type="text"
                placeholder="4242 4242 4242 4242"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white"
                disabled
              />
            </div>

            <div className="flex gap-4">
              <div className="w-1/2">
                <label className="block text-sm font-medium text-slate-400 mb-1">
                  Expiry (MM/YY)
                </label>
                <input
                  type="text"
                  placeholder="12/28"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  disabled
                />
              </div>
              <div className="w-1/2">
                <label className="block text-sm font-medium text-slate-400 mb-1">
                  CVC
                </label>
                <input
                  type="text"
                  placeholder="123"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  disabled
                />
              </div>
            </div>

            <button
              onClick={handleStartTrial}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl px-4 py-2 disabled:opacity-50 flex items-center justify-center gap-2 transition"
            >
              {loading && <LoadingSpinner />}
              {loading ? 'Starting Trial...' : 'Start My 60-Day Trial'}
            </button>
            <p className="text-xs text-slate-500 text-center">
              By clicking, you agree to the Terms of Service. Payment details
              are required.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}