/**
 * File: pages/admin/settings.tsx
 * Description: The main system setup page for the Garage Owner, focusing on core site operations.
 */
import React, { useState, useEffect } from 'react';
import Head from 'next/head';
// import { useSession } from 'next-auth/react'; 

interface SiteSettings {
  groupName: string;
  siteName: string;
  defaultVatRate: number;
  defaultLabourRate: number;
  timezone: string;
  currencyCode: string;
  pricingDisplayMode: 'ex_vat' | 'inc_vat';
  supportedCountries: string[];
  supportedCurrencies: string[];
}

// ✅ CORRECTED LIST: Includes United States
const ALL_COUNTRIES = ["United Kingdom", "Ireland", "Germany", "France", "Spain", "Australia", "United States"];
const ALL_CURRENCIES = ["GBP", "EUR", "USD", "AUD"];

const initialSettings: SiteSettings = {
  groupName: "Loading...",
  siteName: "Loading...",
  defaultVatRate: 20.00,
  defaultLabourRate: 75.00,
  timezone: "Europe/London",
  currencyCode: "GBP",
  pricingDisplayMode: 'ex_vat',
  supportedCountries: ["United Kingdom"],
  supportedCurrencies: ["GBP"],
};

// --- Main Component ---
export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<SiteSettings>(initialSettings);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string, type: 'success' | 'error' | null }>({ text: '', type: null });

  // const { data: session } = useSession({ required: true });

  const fetchSettings = async (groupId: string) => {
    await new Promise(resolve => setTimeout(resolve, 800));
    setSettings({
        groupName: "The Mini Specialist",
        siteName: "TBMS - Birmingham",
        defaultVatRate: 20.00,
        defaultLabourRate: 85.00,
        timezone: "Europe/London",
        currencyCode: "GBP",
        pricingDisplayMode: 'ex_vat',
        supportedCountries: ["United Kingdom", "Ireland"],
        supportedCurrencies: ["GBP", "EUR"],
    });
    setLoading(false);
  };

  const saveSettings = async (data: SiteSettings) => {
    setIsSaving(true);
    setMessage({ text: '', type: null });

    try {
      const response = await fetch('/api/admin/settings/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to save settings.');
      }

      setMessage({ text: 'Settings saved successfully!', type: 'success' });
    } catch (err: any) {
      setMessage({ text: err.message || 'Failed to save settings.', type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    fetchSettings("MOCK_GROUP_ID");
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    
    if (e.target instanceof HTMLSelectElement && e.target.multiple) {
        // Handle multiselect changes
        const options = Array.from(e.target.options);
        const values = options.filter(option => option.selected).map(option => option.value);
        setSettings(prev => ({ ...prev, [name]: values }));
    } else {
        const finalValue = type === 'number' ? parseFloat(value) : value;
        setSettings(prev => ({ ...prev, [name]: finalValue }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    saveSettings(settings);
  };
  
  const inputClass = "w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:ring-blue-500 focus:border-blue-500 transition";
  const labelClass = "block text-sm font-medium text-slate-300 mb-1 mt-3";
  const selectMultipleClass = "w-full p-3 bg-slate-700 border border-slate-600 rounded-lg text-white h-32 focus:ring-blue-500 focus:border-blue-500 transition";
  const sectionHeaderClass = "text-xl font-bold text-blue-400 border-b border-slate-700 pb-2 mb-4";


  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">
        <p className="text-lg">Loading Garage Settings...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 sm:p-8">
      <Head>
        <title>System Settings - GreaseDesk</title>
      </Head>
      
      <div className="max-w-4xl mx-auto bg-slate-800 p-6 sm:p-8 rounded-xl shadow-2xl border border-blue-600/50">
        <h1 className="text-3xl font-bold mb-2">Garage System Setup</h1>
        <p className="text-slate-400 mb-8">
          Configure core settings for **{settings.siteName}**.
        </p>

        {message.text && (
          <div 
            className={`p-3 rounded-lg mb-4 text-sm ${message.type === 'success' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-8">
          
          {/* --- Regional Settings --- */}
          <div>
            <h2 className={sectionHeaderClass}>Regional & Currency Settings</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              
              {/* Supported Countries */}
              <div>
                <label htmlFor="supportedCountries" className={labelClass}>Supported Countries</label>
                <select
                  id="supportedCountries"
                  name="supportedCountries"
                  multiple
                  value={settings.supportedCountries}
                  onChange={handleChange}
                  className={selectMultipleClass}
                >
                  {ALL_COUNTRIES.map(country => (
                      <option key={country} value={country}>{country}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">Hold Ctrl/Cmd to select multiple.</p>
              </div>

              {/* Supported Currencies */}
              <div>
                <label htmlFor="supportedCurrencies" className={labelClass}>Supported Currencies</label>
                <select
                  id="supportedCurrencies"
                  name="supportedCurrencies"
                  multiple
                  value={settings.supportedCurrencies}
                  onChange={handleChange}
                  className={selectMultipleClass}
                >
                  {ALL_CURRENCIES.map(currency => (
                      <option key={currency} value={currency}>{currency}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 mt-1">Hold Ctrl/Cmd to select multiple.</p>
              </div>

            </div>
          </div>
          
          <hr className="border-slate-700" />
          
          {/* --- Pricing and Financial Defaults --- */}
          <div>
            <h2 className={sectionHeaderClass}>Pricing & Financial Rates</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              
              {/* Pricing Display Mode */}
              <div>
                <label htmlFor="pricingDisplayMode" className={labelClass}>Price Entry Mode</label>
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
              
              {/* VAT Rate */}
              <div>
                <label htmlFor="defaultVatRate" className={labelClass}>Default VAT Rate (%)</label>
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

              {/* Labour Rate - CLARIFIED AS EXCLUDING TAX */}
              <div>
                <label htmlFor="defaultLabourRate" className={labelClass}>Default Labour Rate (£/hr, Ex. VAT)</label>
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
            {isSaving ? 'Saving Changes...' : 'Save System Settings'}
          </button>
        </form>
      </div>
    </div>
  );
}