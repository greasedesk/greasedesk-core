/**
 * File: pages/onboarding/rates-settings.tsx
 * Description: Onboarding Step 2 - Collects initial financial and regional settings.
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { useSession, signIn } from 'next-auth/react';
import { GetServerSideProps } from 'next';

const TIMEZONES = [
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Dublin', label: 'Dublin (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
];

type FormData = {
  defaultVatRate: string;
  defaultLabourRate: string;
  timezone: string;
  currencyCode: string;
};

// Initial state, based on UK defaults
const initialData: FormData = {
  defaultVatRate: '20.00',
  defaultLabourRate: '75.00',
  timezone: 'Europe/London',
  currencyCode: 'GBP',
};

const inputClass = 'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:ring-blue-500 focus:border-blue-500 transition';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1 mt-3';

export default function RatesSettingsPage() {
  const router = useRouter();
  const { status } = useSession();
  const [data, setData] = useState<FormData>(initialData);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    // Basic validation
    if (!data.defaultVatRate || !data.defaultLabourRate || !data.currencyCode) {
        setError("Please fill in all required fields.");
        setIsSaving(false);
        return;
    }

    try {
      const res = await fetch('/api/onboarding/update-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      if (!res.ok || result.error) {
        throw new Error(result.message || "Failed to save settings. Please try again.");
      }

      // Success: Redirect to the next setup step (Team Setup)
      router.push('/onboarding/team-invite'); 

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
        <h1 className="text-3xl font-bold mb-2 text-blue-400">Step 2: Financial Setup</h1>
        <p className="text-slate-400 mb-6">
          Set up your primary currency, VAT, and labour rates for your first site.
        </p>

        {error && (
          <div className="bg-red-800 text-red-100 p-3 rounded-lg mb-4 text-sm">{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          
          <h2 className="text-xl font-semibold mt-4 mb-2">Regional Settings</h2>
          <hr className="border-slate-700 mb-4" />
          <label htmlFor="currencyCode" className={labelClass}>Primary Currency Code (e.g., GBP, EUR)</label>
          <input
            id="currencyCode"
            name="currencyCode"
            value={data.currencyCode}
            onChange={handleChange}
            className={inputClass}
            maxLength={3}
            required
          />

          <label htmlFor="timezone" className={labelClass}>Timezone</label>
          <select
            id="timezone"
            name="timezone"
            value={data.timezone}
            onChange={handleChange}
            className={inputClass}
            required
          >
            {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
          </select>

          <h2 className="text-xl font-semibold mt-8 mb-2">Default Financial Rates</h2>
          <hr className="border-slate-700 mb-4" />

          <label htmlFor="defaultVatRate" className={labelClass}>Default VAT Rate (%)</label>
          <input
            type="number"
            step="0.01"
            id="defaultVatRate"
            name="defaultVatRate"
            value={data.defaultVatRate}
            onChange={handleChange}
            className={inputClass}
            required
          />

          <label htmlFor="defaultLabourRate" className={labelClass}>Default Labour Rate (£/hr, Ex. VAT)</label>
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
            {isSaving ? 'Saving & Continuing...' : 'Save & Continue to Team Setup'}
          </button>
        </form>
      </div>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps = async () => {
    return { props: {} };
}