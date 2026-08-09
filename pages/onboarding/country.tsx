/**
 * File: pages/onboarding/country.tsx
 * Onboarding Step 2 — the first question ABOUT THE GARAGE, before currency, timezone or tax (the
 * phone step now leads; see lib/onboarding):
 * every visitor sees their country listed. A SUPPORTED choice configures the rest of the flow
 * (currency, timezones, which tax step renders) and continues. An UNSUPPORTED choice ends on a
 * friendly coming-soon gate that captures an email into the waitlist, with the country.
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOnboardingStep } from '@/lib/admin-guard';
import { PICKER_COUNTRIES } from '@/lib/locale-profiles';
import { enabledCountryOptions } from '@/lib/enabled-countries';

// Enabled countries ONLY (ruling 2026-07-30) — a country the server would refuse is never offered,
// so nothing is selectable-then-bounced. Derived from the same allow-list the API refuses on, so the
// screen and the server cannot drift. The coming-soon/waitlist branch below is kept intact and is
// unreachable while GB is the only enabled country — it comes back the moment a country is opened
// without full support.
const OPTIONS = enabledCountryOptions();

const inputClass = 'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:ring-blue-500 focus:border-blue-500';
const cardClass = 'max-w-lg w-full bg-slate-800 border border-slate-700 rounded-2xl p-8';

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
      if (data.supported) router.push('/onboarding/setup');
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

  return (
    <>
      <Head><title>Where are you? — GreaseDesk</title></Head>
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        {comingSoon ? (
          <div className={cardClass}>
            <h1 className="text-2xl font-bold text-white mb-2">We&rsquo;re not live in {countryName} yet</h1>
            {joined ? (
              <p className="text-slate-300">Thanks — you&rsquo;re on the list. We&rsquo;ll email you the moment GreaseDesk launches in {countryName}.</p>
            ) : (
              <>
                <p className="text-slate-300 mb-5">
                  GreaseDesk is built for {countryName}&rsquo;s way of working, and we&rsquo;re not there quite yet.
                  Leave your email and we&rsquo;ll let you know the moment we launch.
                </p>
                <label className="block text-sm text-slate-400 mb-1">Email</label>
                <input type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@garage.com" />
                {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
                <button onClick={joinWaitlist} disabled={saving || !email.trim()}
                  className="mt-4 w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg px-4 py-3 disabled:opacity-50">
                  {saving ? 'Adding…' : 'Tell me when you launch'}
                </button>
              </>
            )}
            <button onClick={() => { setComingSoon(null); setJoined(false); }} className="mt-4 text-sm text-slate-400 hover:text-white">
              ← Choose a different country
            </button>
          </div>
        ) : (
          <div className={cardClass}>
            <h1 className="text-2xl font-bold text-white mb-1">Where&rsquo;s your garage?</h1>
            <p className="text-slate-400 mb-6">This sets your currency, timezone and tax — so the rest of setup is right for you.</p>
            <label className="block text-sm text-slate-400 mb-1">Country</label>
            <select className={inputClass} value={country} onChange={(e) => setCountry(e.target.value)}>
              {OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
            <button onClick={submit} disabled={saving}
              className="mt-6 w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg px-4 py-3 disabled:opacity-50">
              {saving ? 'Saving…' : 'Continue'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  // Same guard the other steps use: bounce to wherever the tenant actually is in the flow.
  const guard = await requireOnboardingStep(ctx, 'country');
  if (!guard.ok) return { redirect: guard.redirect.destination ? guard.redirect : { destination: '/admin/login', permanent: false } };
  return { props: {} };
};
