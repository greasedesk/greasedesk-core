/**
 * File: pages/onboarding/billing.tsx
 * Onboarding Step 6 — start the subscription (the FINAL, non-skippable step; item-13). A hosted
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
import type { GetServerSideProps } from 'next';
import { requireOnboardingStep } from '@/lib/admin-guard';
import OnboardingLayout, { primaryButtonClass } from '@/components/layout/OnboardingLayout';
import { perLocationLabelFor } from '@/lib/billing-pricing';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { prisma } from '@/lib/db';

type Mode = 'idle' | 'launching' | 'finalising' | 'stuck' | 'unconfigured';

export default function BillingPage({ priceLabel }: { priceLabel: string }) {
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
        // STRAIGHT TO THE DASHBOARD. This used to hand off to the phone step, from the days when
        // that step was optional and ran AFTER payment. The phone step is now the first thing in the
        // wizard, so by the time anyone reaches checkout it is long behind them — sending them there
        // meant a paid tenant bouncing through a completed step's guard to get where they belong.
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
    <OnboardingLayout step="checkout" title="Start your subscription" heading="Start your 60-day free trial">
      {mode === 'finalising' ? (
        <div className="text-center py-6">
          <div className="animate-spin h-8 w-8 border-2 border-line border-t-accent rounded-full mx-auto mb-4" />
          <p className="text-ink">Finalising your subscription…</p>
          <p className="text-xs text-muted mt-2">Confirming with Stripe — this only takes a moment.</p>
        </div>
      ) : mode === 'stuck' ? (
        // ── WARN, NOT DANGER, AND THE SENTENCE IS WHY ──────────────────────────────────────────
        // The money has ALREADY left: Stripe took the card, we simply have not read it back yet.
        // Red here would tell somebody who has just paid us that their payment failed — the single
        // most alarming thing this page could say, and false. warn-soft is "hold on", which is
        // exactly the true state, and the reassurance leads before the retry.
        <div className="py-2">
          <p className="text-sm text-warn bg-warn-soft border border-warn/30 rounded-lg p-3 mb-4" data-testid="billing-stuck">
            Your payment went through — we’re still confirming it with Stripe. Nothing has gone wrong
            and you won’t be charged twice.
          </p>
          <button
            type="button"
            onClick={() => { polls.current = 0; const sid = router.query.session_id as string; if (sid) { setMode('finalising'); confirm(sid); } }}
            className={primaryButtonClass}
          >
            Check again
          </button>
        </div>
      ) : mode === 'unconfigured' ? (
        // OUR fault, not theirs, and unfixable by retrying — so it neither turns red nor offers a
        // button that would do nothing. It is a dead end by nature; the honest thing is to say so
        // and name the way out.
        <p className="text-sm text-warn bg-warn-soft border border-warn/30 rounded-lg p-3" data-testid="billing-unconfigured">
          Card billing isn’t switched on for this environment yet. Please contact support to finish
          setting up your account.
        </p>
      ) : (
        <>
          <div className="bg-surface-muted border border-line p-4 rounded-lg mb-6 text-sm text-muted space-y-2">
            <p><span className="text-ink font-semibold">{priceLabel}</span> per location, per month.</p>
            <p>Your card is verified today but <span className="text-ink font-semibold">not charged</span>. The trial runs 60 days.</p>
            <p>At the end of the trial your card is charged automatically, unless you cancel first. Cancel anytime from Settings → Licence.</p>
          </div>

          {/* CANCELLED IS NEITHER A WARNING NOR AN ERROR — they chose to back out, and the screen
              should not scold them for it. Plain surface, plain sentence. */}
          {cancelled && (
            <div className="bg-surface-muted border border-line text-ink p-3 rounded-lg text-sm mb-4" data-testid="billing-cancelled">
              Checkout cancelled — you can start again whenever you’re ready.
            </div>
          )}
          {/* THE ONE REAL ERROR on this page: checkout would not start. Retrying is the remedy, so
              danger is right — something failed and the next press might work. */}
          {error && (
            <div className="bg-danger-soft border border-danger/30 text-danger p-3 rounded-lg text-sm mb-4" data-testid="billing-error">
              {error}
            </div>
          )}

          <button type="button" onClick={startCheckout} disabled={mode === 'launching'} className={primaryButtonClass}>
            {mode === 'launching' ? 'Opening secure checkout…' : 'Continue to secure checkout'}
          </button>
          <p className="text-xs text-muted text-center mt-3">Payments are handled by Stripe. We never see or store your card details.</p>
        </>
      )}
    </OnboardingLayout>
  );
}

// Wizard step-guard (item-13): reachable only once site + rates + tax are done.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOnboardingStep(ctx, 'checkout');
  if (!gate.ok) return { redirect: gate.redirect };
  // Country-profile price (ruling 2026-07-28): the figure shown here is the figure checkout
  // verifies against the Stripe Price — both halves or neither.
  const group = await prisma.group.findUnique({ where: { id: gate.vis.groupId as string }, select: { country_code: true, ref: true } });
  return { props: { priceLabel: perLocationLabelFor(resolveTenantProfile(group)) } };
};
