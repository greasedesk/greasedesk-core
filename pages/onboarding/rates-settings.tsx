/**
 * File: pages/onboarding/rates-settings.tsx
 * Description: Onboarding Step 4 - Collects initial financial and regional settings.
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
import { useSession, signIn } from 'next-auth/react';
import { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOnboardingStep } from '@/lib/admin-guard';
import { resolveTenantProfile } from '@/lib/locale-profiles';
import { getUsState } from '@/lib/us-states';
import { zoneChoicesFor, initialZone } from '@/lib/timezone-choices';
import TimezoneField from '@/components/TimezoneField';
import { currencySymbol } from '@/lib/format-money';
import OnboardingLayout, { fieldClass, labelClass as sharedLabel, primaryButtonClass, helpClass } from '@/components/layout/OnboardingLayout';

type PageProps = {
  countryName: string;
  currencyCode: string;     // profile currency — display + submitted for server re-validation
  timezones: Array<{ value: string; label: string }>; // zone OPTIONS (state-narrowed for split-state US) —
                            // label is the US zone NAME ("Central Time") or the city elsewhere ("London")
  initialTimezone: string;  // site's stored zone when valid for the options, else the majority/default
  // Timezone render mode (ruling 2026-07-28): a single-zone country (GB/IE) or an unambiguous US
  // state needs no picker — the zone is shown as set, same treatment as currency. Only split
  // states (and stateless multi-zone cases) get a picker.
  timezoneFixed: boolean;
  timezoneNote: string;     // "Set by your country — X" / "Derived from your state — Alabama"
};

type FormData = {
  defaultLabourRate: string;
  timezone: string;
};

// Non-US label: "Europe/London" → "London" — how UK/IE users refer to their zone. US zones get
// named labels (usZoneLabel) computed server-side into the options.
const tzLabel = (z: string) => (z.split('/').pop() ?? z).replace(/_/g, ' ');

const inputClass = fieldClass;
const labelClass = sharedLabel;

export default function RatesSettingsPage({ countryName, currencyCode, timezones, initialTimezone, timezoneFixed, timezoneNote }: PageProps) {
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
  if (status === 'loading') return <div className="min-h-screen bg-content flex items-center justify-center text-muted">Loading…</div>;
  if (status === 'unauthenticated') {
    signIn('credentials', { callbackUrl: '/onboarding/rates-settings' });
    return null;
  }

  return (
    <OnboardingLayout
      step="rates"
      title="Rates & region"
      heading="Rates & region"
      intro="Set your timezone and default labour rate. Currency comes from your country. Tax is the next step."
    >
      {error && <div className="bg-danger-soft text-danger p-3 rounded-lg mb-4 text-sm" data-testid="rates-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <h2 className="text-sm font-semibold text-ink mt-2 mb-2 pb-2 border-b border-line">Regional settings</h2>

        <label htmlFor="currencyCode" className={labelClass}>Currency</label>
        <input
          id="currencyCode"
          value={`${currencyCode} (${rateSym})`}
          className={`${inputClass} bg-surface-muted text-muted cursor-not-allowed`}
          disabled
          readOnly
        />
        <p className={helpClass}>Set by your country — {countryName}.</p>

        <label htmlFor="timezone" className={labelClass}>Timezone</label>
        <TimezoneField
          value={data.timezone}
          options={timezones}
          fixed={timezoneFixed}
          note={timezoneNote}
          onChange={(z) => setData((prev) => ({ ...prev, timezone: z }))}
          inputClass={inputClass}
          noteClass={helpClass}
        />

        <h2 className="text-sm font-semibold text-ink mt-8 mb-2 pb-2 border-b border-line">Default labour rate</h2>

        <label htmlFor="defaultLabourRate" className={labelClass}>Default labour rate ({rateSym}/hr, ex. tax)</label>
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

        <button type="submit" disabled={isSaving} className={`${primaryButtonClass} mt-8`}>
          {isSaving ? 'Saving…' : 'Save & continue to tax'}
        </button>
      </form>
    </OnboardingLayout>
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
    select: { country_code: true, ref: true, sites: { select: { timezone: true, state_code: true }, orderBy: { created_at: 'asc' }, take: 1 } },
  })) as { country_code: string | null; ref: string | null; sites: Array<{ timezone: string | null; state_code: string | null }> } | null;

  const profile = resolveTenantProfile(group);
  const siteTz = group?.sites?.[0]?.timezone ?? null;
  const state = profile.stateField === true ? getUsState(group?.sites?.[0]?.state_code) : null;

  // Zone options: the state narrows within the profile (never widens — lib/us-states maps only to
  // profile zones); no state → the full profile set, exactly as before.
  // Shared derivation (lib/timezone-choices) — Settings uses the same one, so they cannot drift.
  const choices = zoneChoicesFor(profile, group?.sites?.[0]?.state_code);
  const options = choices.options;
  const initialTimezone = initialZone(choices, siteTz);
  const timezoneFixed = choices.fixed;
  const timezoneNote = state
    ? `Derived from your state — ${state.name}.`
    : `Set by your country — ${profile.name}.`;

  return {
    props: {
      countryName: profile.name,
      currencyCode: profile.currency,
      timezones: options,
      initialTimezone,
      timezoneFixed,
      timezoneNote,
    },
  };
};
