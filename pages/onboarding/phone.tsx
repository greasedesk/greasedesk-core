/**
 * File: pages/onboarding/phone.tsx
 * Onboarding Step 2 — the mobile number, straight after the country. It started life outside the
 * gate as an optional afterthought with "I'll do this later" on the button row, spent a few hours
 * last-before-checkout, a few more leading the wizard, and settled here.
 *
 * ── WHY IT MOVED INSIDE ─────────────────────────────────────────────────────────────────────────
 * Optional meant nobody did it: five of five live tenants, zero numbers. A recovery channel nobody
 * has is not a recovery channel, and the moment it is actually needed — a locked-out owner, a failed
 * payment, a card gone wrong on a Saturday — is the moment it is too late to ask.
 *
 * ── WHY IT SITS SECOND (ruling 2026-08-09) ──────────────────────────────────────────────────────
 * Early, because it is the only step about the PERSON rather than the garage, and the only one
 * whose value is being able to reach them when something else has gone wrong — a signup that
 * abandons after this point is one we can still follow up.
 *
 * But NOT first. Ahead of country there is no dial code, so a number is parsed as British whatever
 * it is, and a visitor confirms a handset before learning we are GB-only. One step later the
 * country is known and supported, and the step runs for GB alone (lib/onboarding).
 *
 * ── WHAT THE GUARD DOES ─────────────────────────────────────────────────────────────────────────
 * requireOnboardingStep sends anyone here who is not on this step somewhere else: a grandfathered
 * tenant (created before the cutoff), an exempted one, a non-admin, and anyone who has already
 * recorded a number all resolve to a different step and never see this page. So the page itself
 * carries no conditions — the one rule lives in lib/onboarding and this is a reader of it.
 */
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { requireOnboardingStep } from '@/lib/admin-guard';
import OnboardingLayout from '@/components/layout/OnboardingLayout';
import PhoneVerifyPanel from '@/components/settings/PhoneVerifyPanel';

export default function OnboardingPhone() {
  const router = useRouter();
  // Onward to the GARAGE step. Not the dashboard — four gated steps still stand between here and
  // there, and sending them to a page that would bounce them back is a flicker.
  const go = () => router.replace('/onboarding/setup');
  return (
    <OnboardingLayout step="phone" heading="Confirm your mobile number">
      {/* heading={null}: the layout renders the title, so the panel must not render a second one. */}
      <PhoneVerifyPanel onDone={go} heading={null} />
    </OnboardingLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOnboardingStep(ctx, 'phone');
  if (!gate.ok) return { redirect: gate.redirect };
  return { props: {} };
};
