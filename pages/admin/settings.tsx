/**
 * File: pages/admin/settings.tsx
 * Last edited: 2025-11-13 11:54 Europe/London (FIXED)
 *
 * Admin → System Settings
 * - Preloads Site + VAT + Labour from Prisma (SSR)
 * - Saves to /api/settings/update
 * - Uses Tailwind classes you already have...
 */

import React, { useState } from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
// 💥 FIX: Changed from 'import prisma from '@/lib/db';'
// to a named import to resolve the TypeScript/build error.
import { prisma } from '@/lib/db';

type SiteSettings = {
  groupName: string;
  siteName: string;
  defaultVatRate: number;
  defaultLabourRate: number;
  timezone: string;
  currencyCode: string;
  pricingDisplayMode: 'ex_vat' | 'inc_vat';
  supportedCountries: string[];
  supportedCurrencies: string[];
};

type PageProps = {
  initial: SiteSettings;
};

const ALL_COUNTRIES = ['United Kingdom', 'Ireland', 'Germany', 'France', 'Spain', 'Australia', 'United States'];
const ALL_CURRENCIES = ['GBP', 'EUR', 'USD', 'AUD'];

const inputClass =
  'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:ring-blue-500 focus:border-blue-500 transition';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1 mt-3';
const selectMultipleClass =
  'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white h-32 focus:ring-blue-500 focus:border-blue-500 transition';
const sectionHeaderClass = 'text-xl font-bold text-blue-400 border-b border-slate-700 pb-2 mb-4';

export default function AdminSettingsPage({ initial }: PageProps) {
  const [settings, setSettings] = useState<SiteSettings>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | null }>({
    text: '',
    type: null,
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;

    if (e.target instanceof HTMLSelectElement && e.target.multiple) {
      const options = Array.from(e.target.options);
      const values = options.filter((o) => o.selected).map((o) => o.value);
      setSettings((prev) => ({ ...prev, [name]: values }));
      return;
    }

    if (name === 'defaultVatRate' || name === 'defaultLabourRate') {
      setSettings((prev) => ({ ...prev, [name]: parseFloat(value) }));
    } else if (name === 'currencyCode') {
      setSettings((prev) => ({ ...prev, [name]: value.toUpperCase() }));
    } else {
      setSettings((prev) => ({ ...prev, [name]: value as any }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    setMessage({ text: '', type: null });

    try {
      const res = await fetch('/api/settings/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultVatRate: settings.defaultVatRate,
          defaultLabourRate: settings.defaultLabourRate,
          timezone: settings.timezone,
          currencyCode: settings.currencyCode,
          pricingDisplayMode: settings.pricingDisplayMode,
          supportedCountries: settings.supportedCountries,
          supportedCurrencies: settings.supportedCurrencies,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || 'Failed to save settings.');

      setMessage({ text: 'Settings saved successfully!', type: 'success' });
    } catch (err: any) {
      setMessage({ text: err?.message || 'Failed to save settings.', type: 'error' });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 sm:p-8">
      <Head>
        <title>System Settings - GreaseDesk</title>
      </Head>

      <div className="max-w-4xl mx-auto bg-slate-800 p-6 sm:p-8 rounded-xl shadow-2xl border border-blue-600/50">
        <h1 className="text-3xl font-bold mb-2">Garage System Setup</h1>
        <p className="text-slate-400 mb-8">
          Configure core settings for <strong>{settings.siteName}</strong>.
        </p>

        {message.text && (
          <div
            className={`p-3 rounded-lg mb-4 text-sm ${
              message.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Regional & Currency */}
          <div>
            <h2 className={sectionHeaderClass}>Regional & Currency Settings</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="supportedCountries" className={labelClass}>
                  Supported Countries
                </label>
                <select
                  id="supportedCountries"
                  name="supportedCountries"
                  multiple
                  value={settings.supportedCountries}
                  onChange={handleChange}
                  className={selectMultipleClass}
                >
                  {ALL_COUNTRIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">Hold Ctrl/Cmd to select multiple.</p>
              </div>

              <div>
                <label htmlFor="supportedCurrencies" className={labelClass}>
                  Supported Currencies
                </label>
                <select
                  id="supportedCurrencies"
                  name="supportedCurrencies"
                  multiple
                  value={settings.supportedCurrencies}
                  onChange={handleChange}
                  className={selectMultipleClass}
                >
                  {ALL_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">Hold Ctrl/Cmd to select multiple.</p>
              </div>

              <div>
                <label htmlFor="timezone" className={labelClass}>
                  Timezone
                </label>
                <input
                  id="timezone"
                  name="timezone"
                  value={settings.timezone}
                  onChange={handleChange}
                  className={inputClass}
                />
              </div>

              <div>
                <label htmlFor="currencyCode" className={labelClass}>
                  Primary Currency Code
                </label>
                <input
                  id="currencyCode"
                  name="currencyCode"
                  value={settings.currencyCode}
                  onChange={handleChange}
                  className={inputClass}
                />
              </div>
            </div>
          </div>

          <hr className="border-slate-700" />

          {/* Pricing & Financial */}
          <div>
            <h2 className={sectionHeaderClass}>Pricing & Financial Rates</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="pricingDisplayMode" className={labelClass}>
                  Price Entry Mode
                </label>
                <select
                  id="pricingDisplayMode"
                  name="pricingDisplayMode"
                  value={settings.pricingDisplayMode}
                  onChange={handleChange}
                  className={inputClass}
                >
                  <option value="ex_vat">Excluding VAT (Net Price)</option>
                  <option value="inc_vat">Including VAT (Gross Price)</option>
                </select>
              </div>

              <div>
                <label htmlFor="defaultVatRate" className={labelClass}>
                  Default VAT Rate (%)
                </label>
                <input
                  type="number"
                  step="0.01"
                  id="defaultVatRate"
                  name="defaultVatRate"
                  value={settings.defaultVatRate}
                  onChange={handleChange}
                  className={inputClass}
                  required
                />
              </div>

              <div>
                <label htmlFor="defaultLabourRate" className={labelClass}>
                  Default Labour Rate (£/hr, Ex. VAT)
                </label>
                <input
                  type="number"
                  step="0.01"
                  id="defaultLabourRate"
                  name="defaultLabourRate"
                  value={settings.defaultLabourRate}
                  onChange={handleChange}
                  className={inputClass}
                  required
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition disabled:opacity-50 mt-6"
          >
            {isSaving ? 'Saving Changes…' : 'Save System Settings'}
          </button>
        </form>
      </div>
    </div>
  );
}

// Server-side: load current Site + VAT + Labour from DB
export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/login', permanent: false }, props: {} as any };
  }

  const [site, vatRow, labourSvc, group] = await Promise.all([
    prisma.site.findUnique({
      where: { id: user.site_id },
      select: {
        site_name: true,
        group_id: true,
        timezone: true,
        currency_code: true,
        pricing_display_mode: true,
        supported_countries: true,
        supported_currencies: true,
      },
    }),
    prisma.taxRate.findFirst({
      where: { group_id: user.group_id, name: 'UK VAT' },
      select: { percentage: true },
    }),
    prisma.serviceCatalogue.findFirst({
      where: { group_id: user.group_id, site_id: user.site_id, service_code: 'LABOUR_HR' },
      select: { default_labour_rate: true },
    }),
    prisma.group.findUnique({ where: { id: user.group_id }, select: { group_name: true } }),
  ]);

  const initial: SiteSettings = {
    groupName: group?.group_name ?? 'Your Group',
    siteName: site ? (site as any).site_name ?? 'Your Site' : 'Your Site',
    timezone: site?.timezone ?? 'Europe/London',
    currencyCode: site?.currency_code ?? 'GBP',
    pricingDisplayMode: (site?.pricing_display_mode as 'ex_vat' | 'inc_vat') ?? 'ex_vat',
    supportedCountries: (site?.supported_countries as string[]) ?? ['United Kingdom'],
    supportedCurrencies: (site?.supported_currencies as string[]) ?? ['GBP'],
    defaultVatRate: vatRow ? Number(vatRow.percentage) : 20,
    defaultLabourRate: labourSvc ? Number(labourSvc.default_labour_rate) : 75,
  };

  return { props: { initial } };
};