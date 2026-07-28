/**
 * File: pages/onboarding/rates-settings.tsx
 * Description: Onboarding Step 2 - Collects initial financial and regional settings.
 *
 * COUNTRY-DERIVED (ruling 2026-07-28): everything regional on this step comes from the tenant's
 * country profile (lib/locale-profiles), read server-side. Currency is DISPLAY, not input — one
 * currency per country, set by the country step; the API re-validates against the profile so a
 * tampered form can never write a foreign currency or timezone. The old client constants
 * (GBP / Europe/London / a three-zone EU list) silently overwrote the correct site values the
 * country + site steps had already stored — a US tenant came out GBP/London.
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useSession, signIn } from 'next-auth/react';
import { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOnboardingStep } from '@/lib/admin-guard';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { currencySymbol } from '@/lib/format-money';

type PageProps = {
  countryName: string;
  currencyCode: string;     // profile currency — display + submitted for server re-validation
  timezones: string[];      // the profile's zones, the ONLY options offered
  initialTimezone: string;  // site's stored zone when valid for the profile, else profile default
};

type FormData = {
  defaultLabourRate: string;
  timezone: string;
};

// "America/New_York" → "New York" — a readable label without a second timezone dataset.
const tzLabel = (z: string) => (z.split('/').pop() ?? z).replace(/_/g, ' ');

const inputClass = 'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:ring-blue-500 focus:border-blue-500 transition';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1 mt-3';

export default function RatesSettingsPage({ countryName, currencyCode, timezones, initialTimezone }: PageProps) {
  const router = useRouter();
  const { status } = useSession();
  // Labour rate starts BLANK — the owner must enter their own; we never pre-fill a number
  // (£75 was TMBS's rate leaking into new tenants).
  const [data, setData] = useState<FormData>({ defaultLabourRate: '', timezone: initialTimezone });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rateSym = currencySymbol({ currency: currencyCode }); // derives from the tenant's currency

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    if (!data.defaultLabourRate) {
      setError('Please fill in all required fields.');
      setIsSaving(false);
      return;
    }

    try {
      const res = await fetch('/api/onboarding/update-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, currencyCode }),
      });

      const result = await res.json();

      if (!res.ok || result.error) {
        throw new Error(result.message || 'Failed to save settings. Please try again.');
      }

      // Success: Redirect to the next setup step (Tax profile)
      router.push('/onboarding/tax');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  // Security Check
  if (status === 'loading') return <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">Loading...</div>;
  if (status === 'unauthenticated') {
    signIn('credentials', { callbackUrl: '/onboarding/rates-settings' });
    return null;
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 sm:p-8">
      <Head>
        <title>Setup Rates & Localisation - GreaseDesk</title>
      </Head>

      <div className="max-w-lg mx-auto bg-slate-800 p-6 sm:p-8 rounded-xl shadow-2xl border border-blue-600/50">
        <h1 className="text-3xl font-bold mb-2 text-blue-400">Step 2: Rates &amp; Region</h1>
        <p className="text-slate-400 mb-6">
          Set your timezone and default labour rate. Currency comes from your country. Tax is the next step.
        </p>

        {error && (
          <div className="bg-red-800 text-red-100 p-3 rounded-lg mb-4 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit}>

          <h2 className="text-xl font-semibold mt-4 mb-2">Regional Settings</h2>
          <hr className="border-slate-700 mb-4" />
          <label htmlFor="currencyCode" className={labelClass}>Currency</label>
          <input
            id="currencyCode"
            value={`${currencyCode} (${rateSym})`}
            className={`${inputClass} opacity-70 cursor-not-allowed`}
            disabled
            readOnly
          />
          <p className="text-xs text-slate-500 mt-1">Set by your country — {countryName}.</p>

          <label htmlFor="timezone" className={labelClass}>Timezone</label>
          <select
            id="timezone"
            name="timezone"
            value={data.timezone}
            onChange={handleChange}
            className={inputClass}
            required
          >
            {timezones.map((tz) => <option key={tz} value={tz}>{tzLabel(tz)}</option>)}
          </select>

          <h2 className="text-xl font-semibold mt-8 mb-2">Default Labour Rate</h2>
          <hr className="border-slate-700 mb-4" />

          <label htmlFor="defaultLabourRate" className={labelClass}>Default Labour Rate ({rateSym}/hr, Ex. Tax)</label>
          <input
            type="number"
            step="0.01"
            id="defaultLabourRate"
            name="defaultLabourRate"
            value={data.defaultLabourRate}
            onChange={handleChange}
            className={inputClass}
            required
          />

          <button
            type="submit"
            disabled={isSaving}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition disabled:opacity-50 mt-8"
          >
            {isSaving ? 'Saving & Continuing...' : 'Save & Continue to Tax'}
          </button>
        </form>
      </div>
    </div>
  );
}

// Wizard step-guard (item-13): reachable only as the current incomplete step. Serves the
// COUNTRY-DERIVED initial values — the profile is the source, the site's stored zone wins when it
// is one of the profile's zones (re-entry reflects stored truth, never a hardcoded default).
export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOnboardingStep(ctx, 'rates');
  if (!gate.ok) return { redirect: gate.redirect };
  const groupId = gate.vis.groupId as string;

  const group = (await prisma.group.findUnique({
    where: { id: groupId },
    select: { country_code: true, ref: true, sites: { select: { timezone: true }, orderBy: { created_at: 'asc' }, take: 1 } },
  })) as { country_code: string | null; ref: string | null; sites: Array<{ timezone: string | null }> } | null;

  const profile = resolveTenantProfile(group);
  const siteTz = group?.sites?.[0]?.timezone ?? null;
  const initialTimezone = siteTz && profile.timezones.includes(siteTz) ? siteTz : profile.defaultTimezone;

  return {
    props: {
      countryName: profile.name,
      currencyCode: profile.currency,
      timezones: profile.timezones,
      initialTimezone,
    },
  };
};
