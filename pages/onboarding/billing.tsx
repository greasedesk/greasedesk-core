/**
 * File: pages/onboarding/billing.tsx
 * Start-subscription step. NO card fields, NO false strings — a hosted Stripe Checkout launcher
 * (ruling 2026-07-13: the previous disabled-input form made untrue statements about money on a
 * live domain and was deleted). Real terms only: 60-day free trial, card verified now, first charge
 * a flat monthly price per site at trial end unless cancelled (see lib/billing-pricing — VAT-status aware). When billing is not yet configured
 * (sandbox keys absent) the step is skippable so onboarding still completes.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useSession, signIn } from 'next-auth/react';
import { perLocationLabel } from '@/lib/billing-pricing';

export default function BillingPage() {
  const router = useRouter();
  const sessionResult = useSession();
  const { status } = sessionResult ?? ({ data: null, status: 'loading' } as const);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dormant, setDormant] = useState(false);

  useEffect(() => {
    if (status === 'unauthenticated') signIn('credentials', { callbackUrl: '/onboarding/billing' });
  }, [status]);

  async function startCheckout() {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' });
      if (res.status === 503) { setDormant(true); return; } // billing not configured — skippable
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.message || 'Could not start checkout.');
      window.location.href = data.url; // hand off to hosted Stripe Checkout
    } catch (e: any) {
      setError(e?.message || 'Could not start checkout.');
    } finally {
      setLoading(false);
    }
  }

  if (status === 'loading' || !sessionResult) {
    return <main className="min-h-screen bg-slate-900 flex items-center justify-center text-slate-300">Loading…</main>;
  }

  return (
    <>
      <Head><title>Start your subscription — GreaseDesk</title></Head>
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-800/80 border border-slate-700 rounded-2xl shadow-xl p-8">
          <h1 className="text-xl font-semibold text-white mb-4 text-center">Start your 60-day free trial</h1>
          <div className="bg-slate-700/40 p-4 rounded-lg mb-6 text-sm text-slate-300 space-y-2">
            <p><span className="text-white font-semibold">{perLocationLabel()}</span> per location, per month.</p>
            <p>Your card is verified today but <span className="text-white font-semibold">not charged</span>. The trial runs 60 days.</p>
            <p>At the end of the trial your card is charged automatically, unless you cancel first. Cancel anytime from Settings → Licence.</p>
          </div>

          {error && <div className="bg-red-800/80 border border-red-600 text-red-100 p-3 rounded-lg text-sm mb-4">{error}</div>}

          {dormant ? (
            <>
              <p className="text-sm text-amber-300 mb-4">Card billing isn’t switched on for this environment yet — you can finish setting up and add billing later from Settings → Licence.</p>
              <button onClick={() => router.push('/onboarding/setup')} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl px-4 py-2.5">Continue setup</button>
            </>
          ) : (
            <button onClick={startCheckout} disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl px-4 py-2.5 disabled:opacity-50">
              {loading ? 'Opening secure checkout…' : 'Continue to secure checkout'}
            </button>
          )}
          <p className="text-xs text-slate-500 text-center mt-3">Payments are handled by Stripe. We never see or store your card details.</p>
        </div>
      </main>
    </>
  );
}
