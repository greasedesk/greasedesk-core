/**
 * File: pages/onboarding/billing.tsx
 * Last edited: 2025-11-02 at 21:50
 *
 * SaaS Onboarding Step 4: Billing.
 * FIX: Updated copy to be professional and reassuring ("60-day trial", "contact before billing").
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useSession, signIn } from 'next-auth/react';

// Simple SVG icon for the credit card
const CreditCardIcon = () => (
  <svg 
    className="w-16 h-16 text-gdAccent mx-auto" 
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
  const { data: session, status } = useSession();
  
  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Billing logic ---
  const handleStartTrial = async () => {
    setLoading(true);
    setError(null);

    try {
      // This calls the API to create the GroupBilling record
      const res = await fetch('/api/onboarding/create-billing', {
        method: 'POST',
      });

      if (!res.ok) {
        throw new Error('Could not start your trial. Please contact support.');
      }

      // Success! Redirect to the final step: Garage Setup.
      router.push('/onboarding/setup');

    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // --- Page Security ---
  if (status === 'loading') {
    return (
      <main className="min-h-screen bg-slate-900 flex items-center justify-center">
        <LoadingSpinner />
      </main>
    );
  }

  // If the user is not logged in, redirect them to the Sign In page.
  if (status === 'unauthenticated') {
    signIn(); 
    return null;
  }
  
  // --- Render Page ---
  return (
    <>
      <Head>
        <title>Start Your Trial - Billing - GreaseDesk</title>
      </Head>
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-gdPanel/80 border border-gdBorder rounded-2xl shadow-card p-8">
          
          <CreditCardIcon />

          <h1 className="text-xl font-semibold text-gdText mt-6 mb-4 text-center">
            Start Your Free Trial
          </h1>
          
          {/* --- NEW PROFESSIONAL COPY --- */}
          <p className="text-gdSubtext text-sm mb-6 text-center">
            Your email is verified! To activate your **60-day free trial** and secure your pricing, please enter your payment details.
          </p>
          <div className="bg-slate-700/50 p-4 rounded-lg mb-6">
            <p className="text-xs text-green-300 font-semibold mb-2">Policy on Billing:</p>
            <ul className="text-xs text-slate-300 list-disc list-inside space-y-1 text-left">
                <li>Start your 60-day free trial today — no commitment, just results.</li>
                <li>We’ll arrange a quick web or face-to-face meeting within the first 30 days to make sure you’re getting value.</li>
                <li>If we haven’t met by then, your trial will end after 30 days and your paid plan will begin automatically (unless you cancel first).</li>
            </ul>
          </div>
          {/* --- END NEW COPY --- */}

          {/* --- Error Message --- */}
          {error && (
            <div className="bg-red-800 border border-red-600 text-red-200 p-3 rounded-lg text-center mb-4">
              <p className="font-semibold">Error</p>
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* --- "Fake" Billing Form --- */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gdSubtext mb-1">Card Number</label>
              <input
                type="text"
                placeholder="4242 4242 4242 4242"
                className="w-full bg-slate-800 border border-gdBorder rounded-lg px-3 py-2 text-gdText"
                disabled 
              />
            </div>
            
            <div className="flex gap-4">
              <div className="w-1/2">
                <label className="block text-sm font-medium text-gdSubtext mb-1">Expiry (MM/YY)</label>
                <input
                  type="text"
                  placeholder="12/28"
                  className="w-full bg-slate-800 border border-gdBorder rounded-lg px-3 py-2 text-gdText"
                  disabled
                />
              </div>
              <div className="w-1/2">
                <label className="block text-sm font-medium text-gdSubtext mb-1">CVC</label>
                <input
                  type="text"
                  placeholder="123"
                  className="w-full bg-slate-800 border border-gdBorder rounded-lg px-3 py-2 text-gdText"
                  disabled
                />
              </div>
            </div>

            <button
              onClick={handleStartTrial}
              disabled={loading}
              className="w-full bg-gdAccent text-slate-900 font-medium rounded-xl px-4 py-2 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading && <LoadingSpinner />}
              {loading ? 'Starting Trial...' : 'Start My 60-Day Trial'}
            </button>
            <p className="text-xs text-slate-500 text-center">
              By clicking, you agree to the Terms of Service. Your commitment starts today.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}