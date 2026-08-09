/**
 * File: pages/onboarding/phone.tsx
 * Onboarding Step 5 — the mobile number. IN the gate now (ONBOARDING_ORDER, before checkout), where
 * it started life outside it as an optional afterthought with "I'll do this later" on the button row.
 *
 * ── WHY IT MOVED INSIDE ─────────────────────────────────────────────────────────────────────────
 * Optional meant nobody did it: five of five live tenants, zero numbers. A recovery channel nobody
 * has is not a recovery channel, and the moment it is actually needed — a locked-out owner, a failed
 * payment, a card gone wrong on a Saturday — is the moment it is too late to ask.
 *
 * ── WHY IT SITS BEFORE CHECKOUT AND NOT AFTER ───────────────────────────────────────────────────
 * After checkout the tenant has paid and the gate has nothing left to hold; the step would be
 * skippable in practice by closing the tab. Before checkout it is the last thing between setting up
 * and paying, which is the strongest position it can occupy without standing between a customer and
 * giving us money for longer than one screen.
 *
 * ── WHAT THE GUARD DOES ─────────────────────────────────────────────────────────────────────────
 * requireOnboardingStep sends anyone here who is not on this step somewhere else: a grandfathered
 * tenant (created before the cutoff), an exempted one, a non-admin, and anyone who has already
 * recorded a number all resolve to a different step and never see this page. So the page itself
 * carries no conditions — the one rule lives in lib/onboarding and this is a reader of it.
 */
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { requireOnboardingStep } from '@/lib/admin-guard';
import PhoneVerifyPanel from '@/components/settings/PhoneVerifyPanel';

export default function OnboardingPhone() {
  const router = useRouter();
  // Onward to CHECKOUT, not the dashboard: this step is inside the wizard now, and the dashboard is
  // still gated behind billing. Sending them to a page that would bounce them back is a flicker.
  const go = () => router.replace('/onboarding/billing');
  return (
    <>
      <Head><title>Your mobile number - GreaseDesk</title></Head>
      <div className="min-h-screen bg-surface-muted py-10 px-4">
        <div className="max-w-xl mx-auto bg-surface border border-line rounded-2xl p-6">
          <p className="text-xs text-muted mb-3">Step 5 of 6 — then payment.</p>
          <PhoneVerifyPanel onDone={go} heading="Confirm your mobile number" />
        </div>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOnboardingStep(ctx, 'phone');
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
};
