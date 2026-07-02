/**
 * File: pages/admin/settings/company/details.tsx
 * Company Profile → Company Details (ADMIN/owner only). Company name / number / address, plus the
 * VAT-registered master switch + VAT number (gated: number shown only when registered). Relocated
 * from the pre-i18n profile.tsx CompanyDetails and i18n'd here; the /api/company PATCH contract
 * (group_name, company_number, address, vat_registered, vat_number) is unchanged. Mobile-first.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';

type PageProps = {
  groupName: string; companyNumber: string; address: string; vatRegistered: boolean; vatNumber: string;
};

const inputClass = 'mt-1 w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm focus:ring-accent focus:border-accent';
const labelClass = 'block text-xs text-muted';

export default function CompanyDetails({ groupName, companyNumber, address, vatRegistered, vatNumber }: PageProps) {
  const { t } = useTranslation('company');
  const [name, setName] = useState(groupName);
  const [num, setNum] = useState(companyNumber);
  const [addr, setAddr] = useState(address);
  const [vatReg, setVatReg] = useState(vatRegistered);
  const [vat, setVat] = useState(vatNumber);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/company', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_name: name, company_number: num, address: addr,
          vat_registered: vatReg, vat_number: vatReg ? vat : '', // clear number when de-registering
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('details.error'), ok: false }); setBusy(false); return; }
      setMsg({ text: t('details.saved'), ok: true });
    } catch { setMsg({ text: t('details.error'), ok: false }); }
    setBusy(false);
  }

  return (
    <SettingsLayout isAdmin>
      <Head><title>Company details - GreaseDesk</title></Head>
      <div className="bg-surface border border-line rounded-xl p-6 max-w-md">
        <h2 className="text-lg font-semibold text-ink mb-1">{t('details.title')}</h2>
        <p className="text-sm text-muted mb-4">{t('details.intro')}</p>
        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}
        <form onSubmit={save} className="space-y-3">
          <div><label className={labelClass}>{t('details.name')} *</label><input value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} /></div>
          <div><label className={labelClass}>{t('details.number')}</label><input value={num} onChange={(e) => setNum(e.target.value)} className={inputClass} /></div>
          <div><label className={labelClass}>{t('details.address')}</label><input value={addr} onChange={(e) => setAddr(e.target.value)} className={inputClass} /></div>
          <label className="flex items-start gap-3 py-1 cursor-pointer">
            <input type="checkbox" checked={vatReg} onChange={(e) => setVatReg(e.target.checked)} className="w-5 h-5 mt-0.5" />
            <span>
              <span className="text-sm font-medium text-ink block">{t('details.vatRegistered')}</span>
              <span className="text-xs text-muted">{t('details.vatRegisteredHint')}</span>
            </span>
          </label>
          {vatReg && (
            <div><label className={labelClass}>{t('details.vatNumber')}</label><input value={vat} onChange={(e) => setVat(e.target.value)} className={inputClass} /></div>
          )}
          <button type="submit" disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-50">
            {busy ? t('details.saving') : t('details.save')}
          </button>
        </form>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['company'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const g = (await prisma.group.findUnique({
    where: { id: gate.vis.groupId as string },
    select: { group_name: true, company_number: true, address: true, vat_registered: true, vat_number: true },
  })) as { group_name: string; company_number: string | null; address: string | null; vat_registered: boolean; vat_number: string | null } | null;
  return {
    props: {
      groupName: g?.group_name ?? '',
      companyNumber: g?.company_number ?? '',
      address: g?.address ?? '',
      vatRegistered: !!g?.vat_registered,
      vatNumber: g?.vat_number ?? '',
    },
  };
});
