/**
 * File: pages/onboarding/billing.tsx
 * Onboarding Step 4 — start the subscription (the FINAL, non-skippable step; item-13). A hosted
 * Stripe Checkout launcher: 60-day free trial, card verified today, first charge a flat monthly
 * price per site at trial end unless cancelled. Real terms only (ruling 2026-07-13 — no fake card
 * fields, no untrue money strings on a live domain).
 *
 * Completion is confirmed by a SYNCHRONOUS retrieve on the Checkout return (?session_id), NOT by
 * waiting for the webhook — a lagging webhook must never trap a paid tenant at a spinner. On return
 * we poll /api/stripe/confirm-checkout until Stripe reports trialing/active, then move to the
 * dashboard. Billing is mandatory: there is no skip — the root gate requires a real subscription.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOnboardingStep } from '@/lib/admin-guard';
import { perLocationLabel } from '@/lib/billing-pricing';

type Mode = 'idle' | 'launching' | 'finalising' | 'stuck' | 'unconfigured';

export default function BillingPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);
  const cancelled = router.query.billing === 'cancelled';
  const polls = useRef(0);

  // Synchronous confirm on the Checkout return: read Stripe's truth, advance the moment it's live.
  const confirm = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch('/api/stripe/confirm-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.onboarded) {
        router.replace('/admin/dashboard');
        return;
      }
      // Not live yet (rare, very-early return). Retry a few times, then offer a manual refresh.
      polls.current += 1;
      if (polls.current < 8) {
        setTimeout(() => confirm(sessionId), 2000);
      } else {
        setMode('stuck');
      }
    } catch {
      polls.current += 1;
      if (polls.current < 8) setTimeout(() => confirm(sessionId), 2000);
      else setMode('stuck');
    }
  }, [router]);

  useEffect(() => {
    const sid = typeof router.query.session_id === 'string' ? router.query.session_id : null;
    if (sid) { setMode('finalising'); confirm(sid); }
  }, [router.query.session_id, confirm]);

  async function startCheckout() {
    setMode('launching'); setError(null);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'onboarding' }),
      });
      if (res.status === 503) { setMode('unconfigured'); return; }
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.message || 'Could not start checkout.');
      window.location.href = data.url; // hand off to hosted Stripe Checkout
    } catch (e: any) {
      setError(e?.message || 'Could not start checkout.');
      setMode('idle');
    }
  }

  return (
    <>
      <Head><title>Start your subscription — GreaseDesk</title></Head>
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-800/80 border border-slate-700 rounded-2xl shadow-xl p-8">
          <h1 className="text-xl font-semibold text-white mb-4 text-center">Start your 60-day free trial</h1>

          {mode === 'finalising' ? (
            <div className="text-center py-6">
              <div className="animate-spin h-8 w-8 border-2 border-slate-500 border-t-blue-400 rounded-full mx-auto mb-4" />
              <p className="text-slate-300">Finalising your subscription…</p>
              <p className="text-xs text-slate-500 mt-2">Confirming with Stripe — this only takes a moment.</p>
            </div>
          ) : mode === 'stuck' ? (
            <div className="text-center py-4">
              <p className="text-amber-300 mb-4">Your payment went through — we’re still confirming it with Stripe.</p>
              <button onClick={() => { polls.current = 0; const sid = router.query.session_id as string; if (sid) { setMode('finalising'); confirm(sid); } }}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl px-4 py-2.5">Check again</button>
            </div>
          ) : mode === 'unconfigured' ? (
            <p className="text-sm text-amber-300 py-4 text-center">Card billing isn’t switched on for this environment yet. Please contact support to finish setting up your account.</p>
          ) : (
            <>
              <div className="bg-slate-700/40 p-4 rounded-lg mb-6 text-sm text-slate-300 space-y-2">
                <p><span className="text-white font-semibold">{perLocationLabel()}</span> per location, per month.</p>
                <p>Your card is verified today but <span className="text-white font-semibold">not charged</span>. The trial runs 60 days.</p>
                <p>At the end of the trial your card is charged automatically, unless you cancel first. Cancel anytime from Settings → Licence.</p>
              </div>

              {cancelled && <div className="bg-slate-700/40 border border-slate-600 text-slate-200 p-3 rounded-lg text-sm mb-4">Checkout cancelled — you can start again whenever you’re ready.</div>}
              {error && <div className="bg-red-800/80 border border-red-600 text-red-100 p-3 rounded-lg text-sm mb-4">{error}</div>}

              <button onClick={startCheckout} disabled={mode === 'launching'} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl px-4 py-2.5 disabled:opacity-50">
                {mode === 'launching' ? 'Opening secure checkout…' : 'Continue to secure checkout'}
              </button>
              <p className="text-xs text-slate-500 text-center mt-3">Payments are handled by Stripe. We never see or store your card details.</p>
            </>
          )}
        </div>
      </main>
    </>
  );
}

// Wizard step-guard (item-13): reachable only once site + rates + tax are done.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOnboardingStep(ctx, 'checkout');
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
};
