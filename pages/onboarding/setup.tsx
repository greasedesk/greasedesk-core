/**
 * File: pages/onboarding/setup.tsx
 * Description: Onboarding – collect Group (Company) and initial Site (Garage) details.
 * Last Edited: 2025-11-18 18:45 Europe/London
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOnboardingStep } from '@/lib/admin-guard';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { US_STATES } from '@/lib/us-states';
import OnboardingLayout, { fieldClass, primaryButtonClass, helpClass } from '@/components/layout/OnboardingLayout';

type PageProps = {
  // Country-profile-driven (ruling 2026-07-28): render a structured state select for countries
  // whose profile sets stateField (US) — timezone derives from it. Absent elsewhere.
  stateField: boolean;
  states: Array<{ code: string; name: string }>;
  postcodeLabel: string;
  postcodePlaceholder: string;
};

// Wizard step-guard: only reachable as the FIRST incomplete step; bounces skip-ahead / resumes /
// sends a complete tenant to the dashboard (item-13).
export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOnboardingStep(ctx, 'site');
  if (!gate.ok) return { redirect: gate.redirect };
  const group = await prisma.group.findUnique({
    where: { id: gate.vis.groupId as string },
    select: { country_code: true, ref: true },
  });
  const profile = resolveTenantProfile(group);
  return {
    props: {
      stateField: profile.stateField === true,
      states: profile.stateField === true ? US_STATES.map((s) => ({ code: s.code, name: s.name })) : [],
      postcodeLabel: profile.postcodeLabel,
      postcodePlaceholder: profile.postcodePlaceholder,
    },
  };
};

// Define the expected form data shape
interface SetupData {
  groupName: string;
  siteName: string;
  addressLine1: string;
  city: string;
  postcode: string;
  stateCode: string;
}

// Logo Configuration (Assuming it's placed in /public)

export default function OnboardingSetupPage({ stateField, states, postcodeLabel, postcodePlaceholder }: PageProps) {
  const router = useRouter();
  const [formData, setFormData] = useState<SetupData>({
    groupName: '',
    siteName: '',
    addressLine1: '',
    city: '',
    postcode: '',
    stateCode: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
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
    if (stateField && !formData.stateCode) {
      setError('Please select your state.');
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
  const inputClass = fieldClass;
  const labelClass = 'block text-sm font-medium text-ink mb-1';
  // A grouping panel INSIDE the card, so it must not be the same surface as the card itself.
  const panelClass = 'bg-surface-muted p-4 rounded-xl border border-line';

  return (
    // The logo used to be repeated in the card body; the layout's header carries it now, once.
    <OnboardingLayout
      step="site"
      title="Garage setup"
      heading="Your garage"
      intro="Tell us about your company and your primary garage location to get started."
    >
      {error && (
        <div className="bg-danger-soft text-danger p-3 rounded-lg mb-4 text-sm" data-testid="setup-error">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
            {/* Group (Company) Details */}
            <div className={panelClass}>
              <h2 className="text-sm font-semibold text-ink mb-3">Company details</h2>
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
              <h2 className="text-sm font-semibold text-ink mb-3">Primary garage location</h2>
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
                      {postcodeLabel}
                    </label>
                    <input
                      type="text"
                      id="postcode"
                      name="postcode"
                      value={formData.postcode}
                      onChange={handleChange}
                      className={inputClass}
                      placeholder={postcodePlaceholder}
                      disabled={loading}
                      required
                    />
                  </div>
                </div>
                {stateField && (
                  <div className="mt-4">
                    <label htmlFor="stateCode" className={labelClass}>
                      State
                    </label>
                    <select
                      id="stateCode"
                      name="stateCode"
                      value={formData.stateCode}
                      onChange={handleChange}
                      className={inputClass}
                      disabled={loading}
                      required
                    >
                      <option value="" disabled>Select your state…</option>
                      {states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                    </select>
                    <p className={helpClass}>Sets your timezone; you can adjust it on the next step if your area differs.</p>
                  </div>
                )}
              </div>
            </div>

        <button type="submit" disabled={loading} className={primaryButtonClass}>
          {loading ? 'Setting up your garage…' : 'Save & continue to rates'}
        </button>
      </form>
    </OnboardingLayout>
  );
}
