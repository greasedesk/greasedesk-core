/**
 * File: pages/onboarding/setup.tsx
 * Description: Onboarding – collect Group (Company) and initial Site (Garage) details.
 * Last Edited: 2025-11-18 18:45 Europe/London
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

// Define the expected form data shape
interface SetupData {
  groupName: string;
  siteName: string;
  addressLine1: string;
  city: string;
  postcode: string;
}

// Logo Configuration (Assuming it's placed in /public)
const LOGO_SRC = '/greasedesk-logo-source.png';

export default function OnboardingSetupPage() {
  const router = useRouter();
  const [formData, setFormData] = useState<SetupData>({
    groupName: '',
    siteName: '',
    addressLine1: '',
    city: '',
    postcode: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Simple validation
    if (!formData.groupName || !formData.siteName || !formData.postcode) {
      setError('Group Name, Site Name, and Postcode are required.');
      setLoading(false);
      return;
    }

    try {
      // Call the API route defined in pages/api/onboarding/setup.ts
      const response = await fetch('/api/onboarding/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const responseData = await response.json();

      if (!response.ok) {
        throw new Error(
          responseData.message || 'Failed to complete setup. Please check details.'
        );
      }

      // Use the redirect URL returned by the API, or fall back to the financial setup step
      const nextUrl = responseData.redirectUrl || '/onboarding/rates-settings';
      await router.push(nextUrl);
    } catch (err: any) {
      setError(err.message || 'Unexpected error while completing setup.');
    } finally {
      setLoading(false);
    }
  };

  // Tailwind CSS classes for consistent styling
  const inputClass =
    'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg focus:ring-blue-500 focus:border-blue-500 text-slate-200 placeholder-slate-400';
  const labelClass = 'block text-sm font-medium text-slate-300 mb-1';
  const panelClass = 'bg-slate-700/50 p-4 rounded-xl border border-slate-700';

  return (
    <>
      <Head>
        <title>Garage Setup - GreaseDesk</title>
      </Head>
      <main className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-xl w-full bg-slate-800/80 border border-slate-700 rounded-2xl shadow-xl p-8">
          {/* Logo */}
          <div className="text-center mb-6">
            <img
              src={LOGO_SRC}
              alt="GreaseDesk Logo"
              className="mx-auto"
              style={{ width: '200px', height: 'auto' }}
            />
          </div>

          <h1 className="text-3xl font-bold text-blue-400 mb-2">
            Step 1: Garage Setup
          </h1>
          <p className="text-slate-400 mb-8">
            Tell us about your company and your primary garage location to get started.
          </p>

          {error && (
            <div className="bg-red-800 text-red-200 p-3 rounded-lg mb-4 text-sm">
              Error: {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Group (Company) Details */}
            <div className={panelClass}>
              <h2 className="text-xl font-semibold text-white mb-4">
                Company Details (The Group)
              </h2>
              <div>
                <label htmlFor="groupName" className={labelClass}>
                  Company / Group Name
                </label>
                <input
                  type="text"
                  id="groupName"
                  name="groupName"
                  value={formData.groupName}
                  onChange={handleChange}
                  className={inputClass}
                  placeholder="e.g., AutoFix UK Ltd"
                  disabled={loading}
                  required
                />
              </div>
            </div>

            {/* Site (Garage) Details */}
            <div className={panelClass}>
              <h2 className="text-xl font-semibold text-white mb-4">
                Primary Garage Location (The Site)
              </h2>
              <div className="space-y-4">
                <div>
                  <label htmlFor="siteName" className={labelClass}>
                    Garage/Site Name
                  </label>
                  <input
                    type="text"
                    id="siteName"
                    name="siteName"
                    value={formData.siteName}
                    onChange={handleChange}
                    className={inputClass}
                    placeholder="e.g., AutoFix Birmingham"
                    disabled={loading}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="addressLine1" className={labelClass}>
                    Address Line 1
                  </label>
                  <input
                    type="text"
                    id="addressLine1"
                    name="addressLine1"
                    value={formData.addressLine1}
                    onChange={handleChange}
                    className={inputClass}
                    placeholder="e.g., 12 Industrial Estate"
                    disabled={loading}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="city" className={labelClass}>
                      City
                    </label>
                    <input
                      type="text"
                      id="city"
                      name="city"
                      value={formData.city}
                      onChange={handleChange}
                      className={inputClass}
                      placeholder="e.g., Birmingham"
                      disabled={loading}
                    />
                  </div>
                  <div>
                    <label htmlFor="postcode" className={labelClass}>
                      Postcode
                    </label>
                    <input
                      type="text"
                      id="postcode"
                      name="postcode"
                      value={formData.postcode}
                      onChange={handleChange}
                      className={inputClass}
                      placeholder="e.g., B1 2AB"
                      disabled={loading}
                      required
                    />
                  </div>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition disabled:opacity-50"
            >
              {loading
                ? 'Setting up garage...'
                : 'Save & Continue to Financial Setup'}
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
