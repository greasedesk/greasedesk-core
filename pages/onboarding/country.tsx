/**
 * File: pages/onboarding/country.tsx
 * Onboarding Step 1 — the first question, before currency, timezone, tax or even a phone number:
 * every visitor sees their country listed. A SUPPORTED choice configures the rest of the flow
 * (currency, timezones, which tax step renders) and continues. An UNSUPPORTED choice ends on a
 * friendly coming-soon gate that captures an email into the waitlist, with the country.
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { requireOnboardingStep } from '@/lib/admin-guard';
import OnboardingLayout, { fieldClass, primaryButtonClass } from '@/components/layout/OnboardingLayout';
import { PICKER_COUNTRIES } from '@/lib/locale-profiles';
import { enabledCountryOptions } from '@/lib/enabled-countries';

// Enabled countries ONLY (ruling 2026-07-30) — a country the server would refuse is never offered,
// so nothing is selectable-then-bounced. Derived from the same allow-list the API refuses on, so the
// screen and the server cannot drift. The coming-soon/waitlist branch below is kept intact and is
// unreachable while GB is the only enabled country — it comes back the moment a country is opened
// without full support.
const OPTIONS = enabledCountryOptions();


export default function CountryStepPage() {
  const router = useRouter();
  const [country, setCountry] = useState('GB');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Coming-soon gate state (unsupported country).
  const [comingSoon, setComingSoon] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [joined, setJoined] = useState(false);

  async function submit() {
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/onboarding/country', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'Could not save your country.');
      if (data.supported) router.push('/onboarding/phone');
      else setComingSoon(country);
    } catch (e: any) { setError(e?.message || 'Something went wrong.'); }
    finally { setSaving(false); }
  }

  async function joinWaitlist() {
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/onboarding/waitlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'Could not add you to the list.');
      setJoined(true);
    } catch (e: any) { setError(e?.message || 'Something went wrong.'); }
    finally { setSaving(false); }
  }

  const countryName = PICKER_COUNTRIES.find((c) => c.code === comingSoon)?.name ?? 'your country';

  // ── THE COMING-SOON BRANCH IS A REFUSAL, NOT A FAULT ──────────────────────────────────────────
  // Deliberately NOT danger-soft. "We aren't open in Ireland yet" is disappointing news about our
  // coverage, not something the visitor did wrong and not something they can fix by trying again —
  // red would read as an error they had caused. warn-soft says "stop, this isn't going to work
  // today" while leaving the tone right for a page whose whole job is to keep them interested.
  if (comingSoon) {
    return (
      <OnboardingLayout
        title="Not live here yet"
        heading={`We’re not live in ${countryName} yet`}
      >
        {joined ? (
          // The ONE genuinely good outcome on this screen, so it gets the positive token.
          <p className="text-sm text-ok bg-ok-soft border border-ok/30 rounded-lg p-3" data-testid="waitlist-joined">
            Thanks — you’re on the list. We’ll email you the moment GreaseDesk launches in {countryName}.
          </p>
        ) : (
          <>
            <p className="text-sm text-warn bg-warn-soft border border-warn/30 rounded-lg p-3 mb-5" data-testid="coming-soon">
              GreaseDesk is built for {countryName}’s way of working, and we’re not there quite yet.
              Leave your email and we’ll let you know the moment we launch.
            </p>
            <label className="block text-sm font-medium text-ink mb-1" htmlFor="waitlist-email">Email</label>
            <input id="waitlist-email" type="email" className={fieldClass} value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@garage.com" />
            {/* A FAILED WAITLIST SIGN-UP *is* an error, and reads as one. Two different reds would
                be a muddle; this is the only danger state on the page. */}
            {error && <p className="text-sm text-danger mt-2" data-testid="country-error">{error}</p>}
            <button type="button" onClick={joinWaitlist} disabled={saving || !email.trim()}
              className={`${primaryButtonClass} mt-4`}>
              {saving ? 'Adding…' : 'Tell me when you launch'}
            </button>
          </>
        )}
        <button type="button" onClick={() => { setComingSoon(null); setJoined(false); setError(null); }}
          className="mt-4 text-sm text-muted hover:text-ink underline underline-offset-2">
          ← Choose a different country
        </button>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout
      step="country"
      heading="Where’s your garage?"
      intro="This sets your currency, timezone and tax — so the rest of setup is right for you."
    >
      <label className="block text-sm font-medium text-ink mb-1" htmlFor="country">Country</label>
      <select id="country" className={fieldClass} value={country} onChange={(e) => setCountry(e.target.value)}>
        {OPTIONS.map((c) => (
          <option key={c.code} value={c.code}>{c.name}</option>
        ))}
      </select>
      {error && <p className="text-sm text-danger mt-2" data-testid="country-error">{error}</p>}
      <button type="button" onClick={submit} disabled={saving} className={`${primaryButtonClass} mt-6`}>
        {saving ? 'Saving…' : 'Continue'}
      </button>
    </OnboardingLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  // Same guard the other steps use: bounce to wherever the tenant actually is in the flow.
  const guard = await requireOnboardingStep(ctx, 'country');
  if (!guard.ok) return { redirect: guard.redirect.destination ? guard.redirect : { destination: '/admin/login', permanent: false } };
  return { props: {} };
};
