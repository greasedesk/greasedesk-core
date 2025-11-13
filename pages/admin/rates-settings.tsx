/**
 * File: pages/admin/rates-settings.tsx
 * Description: Main Application Settings page for modifying financial and regional rates.
 */

// This page will mirror the functionality of pages/onboarding/rates-settings.tsx 
// but will include server-side rendering (SSR) to load the *current* settings 
// from the database, using the user's session context.

import React, { useState } from 'react';
import Head from 'next/head';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client'; 

// Data Types
type SiteRates = {
  timezone: string;
  currencyCode: string;
  defaultVatRate: string;
  defaultLabourRate: string;
};

type PageProps = {
  initial: SiteRates;
};

const TIMEZONES = [
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Dublin', label: 'Dublin (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
];

const inputClass = 'w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:ring-blue-500 focus:border-blue-500 transition';
const labelClass = 'block text-sm font-medium text-slate-300 mb-1 mt-3';

export default function AdminRatesSettingsPage({ initial }: PageProps) {
  const [data, setData] = useState<SiteRates>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | null }>({
    text: '',
    type: null,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setData((prev) => ({ ...prev, [name]: value }));
  };
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setMessage({ text: '', type: null });

    try {
      // NOTE: This assumes a robust /api/settings/update exists to save changes
      const res = await fetch('/api/settings/update', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.message || 'Failed to save settings.');

      setMessage({ text: 'Rates and regional settings saved successfully!', type: 'success' });
    } catch (err: any) {
      setMessage({ text: err.message, type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="p-4">
      <Head>
        <title>Rates & Localisation Settings - GreaseDesk</title>
      </Head>

      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold mb-2">Rates & Regional Settings</h1>
        <p className="text-slate-400 mb-6">Modify default VAT, labour rates, and regional settings for your current site.</p>

        {message.text && (
          <div
            className={`p-3 rounded-lg mb-4 text-sm ${
              message.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="bg-slate-800 p-6 rounded-xl shadow-lg border border-slate-700">
          
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
            className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition disabled:opacity-50 mt-8"
          >
            {isSaving ? 'Saving Changes...' : 'Save Settings'}
          </button>
        </form>
      </div>
    </div>
  );
}

// Server-side: Load the current settings for the user's site/group
export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
    const session = await getServerSession(ctx.req, ctx.res, authOptions);
    const user = session?.user as any;

    if (!user?.group_id || !user?.site_id) {
        return { redirect: { destination: '/admin/login', permanent: false }, props: {} as any };
    }

    const [site, vatRow, labourSvc] = await Promise.all([
        prisma.site.findUnique({
            where: { id: user.site_id },
            select: { timezone: true, currency_code: true },
        }),
        prisma.taxRate.findFirst({
            where: { group_id: user.group_id, name: 'UK VAT' },
            select: { percentage: true },
        }),
        prisma.serviceCatalogue.findFirst({
            where: { group_id: user.group_id, site_id: user.site_id, service_code: 'LABOUR_HR' },
            select: { default_labour_rate: true },
        }),
    ]);
    
    // Default values if records are missing
    const initial: SiteRates = {
        timezone: site?.timezone ?? 'Europe/London',
        currencyCode: site?.currency_code ?? 'GBP',
        defaultVatRate: vatRow ? new Prisma.Decimal(vatRow.percentage).toFixed(2) : '20.00',
        defaultLabourRate: labourSvc ? new Prisma.Decimal(labourSvc.default_labour_rate).toFixed(2) : '75.00',
    };

    return { props: { initial } };
};