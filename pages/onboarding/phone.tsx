/**
 * File: pages/onboarding/phone.tsx
 * Onboarding Step 1 — the mobile number, and the FIRST thing asked after sign-in. It started life
 * outside the gate as an optional afterthought with "I'll do this later" on the button row, spent a
 * few hours sitting last-before-checkout, and now leads.
 *
 * ── WHY IT MOVED INSIDE ─────────────────────────────────────────────────────────────────────────
 * Optional meant nobody did it: five of five live tenants, zero numbers. A recovery channel nobody
 * has is not a recovery channel, and the moment it is actually needed — a locked-out owner, a failed
 * payment, a card gone wrong on a Saturday — is the moment it is too late to ask.
 *
 * ── WHY IT LEADS (ruling 2026-08-09) ────────────────────────────────────────────────────────────
 * It is the only step that is about the PERSON rather than the garage, and the only one whose whole
 * value is being able to reach them when something else has gone wrong. Asked first, we hold a way
 * to contact whoever is setting this up before they have entered a single fact we could ring them
 * about. Asked last, the one signup that abandons halfway is the one we can never follow up.
 *
 * The cost is stated in lib/onboarding: it runs before COUNTRY, so a non-GB visitor confirms a
 * number before learning we are GB-only. Harmless while the country step refuses everything else.
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
  // Onward to COUNTRY, the next step. Not the dashboard — five gated steps still stand between
  // here and there, and sending them to a page that would bounce them back is a flicker.
  const go = () => router.replace('/onboarding/country');
  return (
    <>
      <Head><title>Your mobile number - GreaseDesk</title></Head>
      <div className="min-h-screen bg-surface-muted py-10 px-4">
        <div className="max-w-xl mx-auto bg-surface border border-line rounded-2xl p-6">
          <p className="text-xs text-muted mb-3">Step 1 of 6 — before anything about the garage.</p>
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
