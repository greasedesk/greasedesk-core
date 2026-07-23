/**
 * File: pages/admin/settings/financial.tsx
 * Settings → Financial: regional/currency/VAT/labour (saved via /api/settings/update),
 * plus Profit Centre TAGS management (reporting tags via /api/profit-centres).
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { currencySymbol } from '@/lib/format-money';

type SiteSettings = {
  siteName: string;
  defaultLabourRate: number;
  timezone: string;
  currencyCode: string;
  pricingDisplayMode: 'ex_vat' | 'inc_vat';
  supportedCountries: string[];
};
type PcTag = { id: string; name: string; category: string | null };
type SiteOpt = { id: string; name: string };
type PageProps = { initial: SiteSettings; profitCentres: PcTag[]; sites: SiteOpt[]; selectedSiteId: string; isAdmin: boolean; locale: string };

const ALL_COUNTRIES = ['United Kingdom', 'Ireland', 'Germany', 'France', 'Spain', 'Australia', 'United States'];
const CATEGORY_OPTIONS = [
  { value: 'repairs', label: 'Repairs' },
  { value: 'mot', label: 'MOT' },
  { value: 'spraybooth', label: 'Spraybooth' },
  { value: 'car_sales', label: 'Car Sales' },
];
const categoryLabel = (v: string | null) => CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? (v ?? '—');

const inputClass =
  'w-full p-3 bg-surface border border-line rounded-lg text-ink placeholder-muted focus:ring-accent focus:border-accent transition';
const labelClass = 'block text-sm font-medium text-muted mb-1 mt-3';
const selectMultipleClass =
  'w-full p-3 bg-surface border border-line rounded-lg text-ink h-32 focus:ring-accent focus:border-accent transition';
const sectionHeaderClass = 'text-xl font-bold text-accent border-b border-line pb-2 mb-4';

async function mutate(url: string, method: string, body: any): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? null : data?.message || 'Request failed.';
  } catch {
    return 'Network error.';
  }
}

// --- Profit Centre tag manager (compact) --- (tags are per-site; scoped to the selected location)
function ProfitCentreTags({ tags, siteId }: { tags: PcTag[]; siteId: string }) {
  const router = useRouter();
  const refresh = () => router.replace(router.asPath);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('repairs');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const error = await mutate('/api/profit-centres', 'POST', { name, category, siteId });
    setBusy(false);
    if (error) return setErr(error);
    setName('');
    setCategory('repairs');
    refresh();
  }
  async function remove(id: string) {
    const error = await mutate('/api/profit-centres', 'DELETE', { id });
    if (error) return setErr(error);
    refresh();
  }
  async function changeCategory(id: string, value: string) {
    const error = await mutate('/api/profit-centres', 'PATCH', { id, category: value });
    if (error) return setErr(error);
    refresh();
  }

  return (
    <div className="max-w-4xl mx-auto bg-surface p-6 rounded-xl border border-line mt-6">
      <h2 className={sectionHeaderClass}>Profit Centre Tags (reporting)</h2>
      <p className="text-muted text-sm mb-4">
        Typed tags applied to job cards &amp; bookings for P&amp;L reporting. They are not operational — the
        operational structure is Locations &amp; Resources.
      </p>
      {err && <div className="bg-danger text-white p-2 rounded text-sm mb-3">{err}</div>}

      {tags.length === 0 ? (
        <p className="text-muted text-sm mb-4">No tags yet.</p>
      ) : (
        <div className="space-y-2 mb-4">
          {tags.map((t) => (
            <div key={t.id} className="flex items-center justify-between bg-surface-muted rounded-lg px-3 py-2">
              <span className="text-ink font-medium">{t.name}</span>
              <div className="flex items-center gap-3">
                <select
                  value={t.category ?? 'repairs'}
                  onChange={(e) => changeCategory(t.id, e.target.value)}
                  className="p-1.5 bg-surface border border-line rounded text-ink text-xs"
                  title={`Category: ${categoryLabel(t.category)}`}
                >
                  {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button onClick={() => remove(t.id)} className="text-xs text-danger hover:underline">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={add} className="flex flex-wrap items-end gap-2 pt-3 border-t border-line">
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Tag name (e.g. Repairs)" className="p-2 bg-surface border border-line rounded text-ink text-sm flex-1 min-w-[160px]" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="p-2 bg-surface border border-line rounded text-ink text-sm">
          {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="submit" disabled={busy} className="text-sm bg-accent hover:bg-accent-hover text-white font-semibold rounded px-3 py-2 disabled:opacity-50">
          {busy ? 'Adding…' : 'Add Tag'}
        </button>
      </form>
    </div>
  );
}

export default function FinancialSettings({ initial, profitCentres, sites, selectedSiteId, isAdmin, locale, taxLabelInitial, fyStartMonthInitial }: PageProps & { taxLabelInitial?: string; fyStartMonthInitial?: number }) {
  const router = useRouter();
  const [settings, setSettings] = useState<SiteSettings>(initial);
  const rateSym = currencySymbol({ currency: settings.currencyCode, locale }); // labour-rate unit label, from the tenant currency
  const [isSaving, setIsSaving] = useState(false);
  const [taxLabel, setTaxLabel] = useState(taxLabelInitial ?? 'VAT');
  const [fyStartMonth, setFyStartMonth] = useState(String(fyStartMonthInitial ?? 4)); // business-wide (Group), like the tax label
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | null }>({ text: '', type: null });

  // Switching location reloads SSR with that site's settings (?site=<id>).
  function switchSite(id: string) {
    router.push({ pathname: router.pathname, query: { site: id } });
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    if (e.target instanceof HTMLSelectElement && e.target.multiple) {
      const values = Array.from(e.target.options).filter((o) => o.selected).map((o) => o.value);
      setSettings((prev) => ({ ...prev, [name]: values }));
      return;
    }
    if (name === 'defaultLabourRate') {
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
          siteId: selectedSiteId,
          defaultLabourRate: settings.defaultLabourRate,
          timezone: settings.timezone,
          currencyCode: settings.currencyCode,
          pricingDisplayMode: settings.pricingDisplayMode,
          supportedCountries: settings.supportedCountries,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || 'Failed to save settings.');
      // Tax LABEL + FY start are business-wide (Group) — saved via the admin company API alongside site settings.
      await fetch('/api/company', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tax_label: taxLabel, fy_start_month: Number(fyStartMonth) }) }).catch(() => {});
      setMessage({ text: 'Settings saved successfully!', type: 'success' });
    } catch (err: any) {
      setMessage({ text: err?.message || 'Failed to save settings.', type: 'error' });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <SettingsLayout isAdmin={isAdmin}>
      <Head><title>Financial Settings - GreaseDesk</title></Head>

      <div className="max-w-4xl mx-auto bg-surface p-6 sm:p-8 rounded-xl border border-line">
        {sites.length > 1 && (
          <div className="mb-6">
            <label htmlFor="siteSelect" className={labelClass}>Location</label>
            <select id="siteSelect" value={selectedSiteId} onChange={(e) => switchSite(e.target.value)} className={inputClass}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
        <p className="text-muted mb-6">Financial &amp; regional settings for <strong>{settings.siteName}</strong>. The VAT rate is business-wide (applies to every location).</p>

        {message.text && (
          <div className={`p-3 rounded-lg mb-4 text-sm ${message.type === 'success' ? 'bg-ok text-white' : 'bg-danger text-white'}`}>
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-8">
          <div>
            <h2 className={sectionHeaderClass}>Regional &amp; Currency Settings</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="supportedCountries" className={labelClass}>Supported Countries</label>
                <select id="supportedCountries" name="supportedCountries" multiple value={settings.supportedCountries} onChange={handleChange} className={selectMultipleClass}>
                  {ALL_COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <p className="text-xs text-muted mt-1">Hold Ctrl/Cmd to select multiple.</p>
              </div>
              <div>
                <label htmlFor="timezone" className={labelClass}>Timezone</label>
                <input id="timezone" name="timezone" value={settings.timezone} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label htmlFor="currencyCode" className={labelClass}>Primary Currency Code</label>
                <input id="currencyCode" name="currencyCode" value={settings.currencyCode} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label htmlFor="taxLabel" className={labelClass}>Tax Label</label>
                <input id="taxLabel" value={taxLabel} maxLength={20} onChange={(e) => setTaxLabel(e.target.value)} className={inputClass} placeholder="VAT" />
                <p className="text-xs text-muted mt-1">What your sales tax is called on invoices — e.g. VAT, GST, Sales Tax. You set it; GreaseDesk never derives it from country.</p>
              </div>
              <div>
                <label htmlFor="fyStartMonth" className={labelClass}>Financial year starts</label>
                <select id="fyStartMonth" value={fyStartMonth} onChange={(e) => setFyStartMonth(e.target.value)} className={inputClass}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={String(m)}>{new Date(2026, m - 1, 1).toLocaleDateString(locale, { month: 'long' })}</option>
                  ))}
                </select>
                <p className="text-xs text-muted mt-1">What your accounting year runs from — used for financial-year reporting. Business-wide (every location). Most UK businesses run April to March.</p>
              </div>
            </div>
          </div>

          <hr className="border-line" />

          <div>
            <h2 className={sectionHeaderClass}>Pricing &amp; Financial Rates</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="pricingDisplayMode" className={labelClass}>Price Entry Mode</label>
                <select id="pricingDisplayMode" name="pricingDisplayMode" value={settings.pricingDisplayMode} onChange={handleChange} className={inputClass}>
                  <option value="ex_vat">Excluding VAT (Net Price)</option>
                  <option value="inc_vat">Including VAT (Gross Price)</option>
                </select>
                <p className="text-xs text-muted mt-1">The default VAT rate lives in Company Profile → Company Details.</p>
              </div>
              <div>
                <label htmlFor="defaultLabourRate" className={labelClass}>Default Labour Rate ({rateSym}/hr, Ex. VAT)</label>
                <input type="number" step="0.01" id="defaultLabourRate" name="defaultLabourRate" value={settings.defaultLabourRate} onChange={handleChange} className={inputClass} required />
              </div>
            </div>
          </div>

          <button type="submit" disabled={isSaving} className="w-full py-3 bg-ok hover:bg-ok text-white font-semibold rounded-lg transition disabled:opacity-50 mt-6">
            {isSaving ? 'Saving Changes…' : 'Save Financial Settings'}
          </button>
        </form>
      </div>

      <ProfitCentreTags tags={profitCentres} siteId={selectedSiteId} />
    </SettingsLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  // ADMIN-ONLY: financial settings (rates/VAT/currency/PC tags) are not editable by STANDARD users.
  // requireAdminPage now carries the root onboarding gate (item-13): a not-fully-set-up tenant is
  // redirected to its first incomplete step here, so the old !site_id → setup-location leaf patch is
  // gone. site is DB-derived (vis.primarySiteId), never the stale-JWT token site_id.
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const { vis } = gate;
  const groupId = vis.groupId as string;

  type PcDbRow = { id: string; name: string; category: string | null };
  type SiteDbRow = { id: string; site_name: string };

  // All-locations: pick the target site from ?site=<id>, validated to belong to the group;
  // fall back to the caller's primary site. The per-site settings below load for that site.
  const allSites = (await prisma.site.findMany({
    where: { group_id: groupId }, orderBy: { site_name: 'asc' }, select: { id: true, site_name: true },
  })) as SiteDbRow[];
  const requested = typeof ctx.query.site === 'string' ? ctx.query.site : '';
  const selectedSiteId = allSites.some((s) => s.id === requested) ? requested : (vis.primarySiteId ?? allSites[0]?.id as string);

  const [site, labourSvc, pcs] = await Promise.all([
    prisma.site.findUnique({
      where: { id: selectedSiteId },
      select: { site_name: true, timezone: true, currency_code: true, locale: true, pricing_display_mode: true, supported_countries: true },
    }),
    prisma.serviceCatalogue.findFirst({ where: { group_id: groupId, site_id: selectedSiteId, service_code: 'LABOUR_HR' }, select: { default_labour_rate: true } }),
    prisma.profitCentre.findMany({ where: { site_id: selectedSiteId }, orderBy: { name: 'asc' }, select: { id: true, name: true, category: true } }) as Promise<PcDbRow[]>,
  ]);

  const initial: SiteSettings = {
    siteName: site?.site_name ?? 'Your Site',
    timezone: site?.timezone ?? 'Europe/London',
    currencyCode: site?.currency_code ?? 'GBP',
    pricingDisplayMode: (site?.pricing_display_mode as 'ex_vat' | 'inc_vat') ?? 'ex_vat',
    supportedCountries: (site?.supported_countries as string[]) ?? ['United Kingdom'],
    defaultLabourRate: labourSvc ? Number(labourSvc.default_labour_rate) : 0, // never pre-fill TMBS's £75
  };

  const profitCentres: PcTag[] = pcs.map((p: PcDbRow) => ({ id: p.id, name: p.name, category: p.category }));
  const sites: SiteOpt[] = allSites.map((s) => ({ id: s.id, name: s.site_name }));

  const grpTax = (await prisma.group.findUnique({ where: { id: groupId }, select: { tax_label: true, fy_start_month: true } })) as any;
  return { props: { initial, profitCentres, sites, selectedSiteId, isAdmin: true, locale: (site as any)?.locale ?? 'en-GB', taxLabelInitial: grpTax?.tax_label ?? 'VAT', fyStartMonthInitial: grpTax?.fy_start_month ?? 4 } };
};
