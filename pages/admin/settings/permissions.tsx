/**
 * File: pages/admin/settings/permissions.tsx
 * Settings → Permissions (ADMIN/owner only). Per-tenant toggles that relax STANDARD authority.
 * Read/enforced server-side via lib/permissions.ts; this is the admin control surface.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import { useTranslation } from 'next-i18next';
import { prisma } from '@/lib/db';
import SettingsLayout from '@/components/layout/SettingsLayout';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';

type PageProps = {
  standardViewInvoices: boolean;
  standardEditPricing: boolean; standardDiaryEntries: boolean;
  managerSeeValues: boolean; managerSeeMargin: boolean; standardSeeValues: boolean; standardSeeMargin: boolean;
};

function Toggle({ on, onChange, label, desc }: { on: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
  const { t } = useTranslation('permissions');
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b border-line">
      <div className="min-w-0">
        <div className="text-ink font-medium">{label}</div>
        <p className="text-sm text-muted mt-0.5">{desc}</p>
      </div>
      <button
        type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
        className={`shrink-0 w-14 h-8 rounded-full flex items-center transition-colors ${on ? 'bg-accent justify-end' : 'bg-surface-muted border border-line justify-start'}`}
      >
        <span className="w-6 h-6 mx-1 rounded-full bg-white shadow" />
        <span className="sr-only">{on ? t('on') : t('off')}</span>
      </button>
    </div>
  );
}

export default function PermissionsSettings(props: PageProps) {
  const { t } = useTranslation('permissions');
  const [pricing, setPricing] = useState(props.standardEditPricing);
  const [diary, setDiary] = useState(props.standardDiaryEntries);
  const [viewInv, setViewInv] = useState(props.standardViewInvoices);
  const [mgrValues, setMgrValues] = useState(props.managerSeeValues);
  const [mgrMargin, setMgrMargin] = useState(props.managerSeeMargin);
  const [stdValues, setStdValues] = useState(props.standardSeeValues);
  const [stdMargin, setStdMargin] = useState(props.standardSeeMargin);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/permissions', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ standardEditPricing: pricing, standardDiaryEntries: diary, standardViewInvoices: viewInv, managerSeeValues: mgrValues, managerSeeMargin: mgrMargin, standardSeeValues: stdValues, standardSeeMargin: stdMargin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ text: data?.message || t('error'), ok: false }); setBusy(false); return; }
      setMsg({ text: t('saved'), ok: true });
    } catch {
      setMsg({ text: t('error'), ok: false });
    }
    setBusy(false);
  }

  return (
    <SettingsLayout isAdmin>
      <Head><title>Permissions - GreaseDesk</title></Head>
      <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
        <h2 className="text-lg font-semibold text-ink mb-1">{t('title')}</h2>
        <p className="text-sm text-muted mb-4">{t('intro')}</p>
        {msg && <div className={`p-2 rounded mb-3 text-sm ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        <Toggle on={pricing} onChange={setPricing} label={t('editPricing.label')} desc={t('editPricing.desc')} />
        <Toggle on={diary} onChange={setDiary} label={t('diaryEntries.label')} desc={t('diaryEntries.desc')} />
        <Toggle on={viewInv} onChange={setViewInv} label={t('viewInvoices.label')} desc={t('viewInvoices.desc')} />

        <h3 className="text-sm font-semibold text-ink mt-6 mb-1">{t('finance.heading')}</h3>
        <p className="text-sm text-muted mb-2">{t('finance.intro')}</p>
        <Toggle on={mgrValues} onChange={setMgrValues} label={t('finance.managerValues.label')} desc={t('finance.managerValues.desc')} />
        <Toggle on={mgrMargin} onChange={setMgrMargin} label={t('finance.managerMargin.label')} desc={t('finance.managerMargin.desc')} />
        <Toggle on={stdValues} onChange={setStdValues} label={t('finance.standardValues.label')} desc={t('finance.standardValues.desc')} />
        <Toggle on={stdMargin} onChange={setStdMargin} label={t('finance.standardMargin.label')} desc={t('finance.standardMargin.desc')} />

        <div className="mt-5">
          <button onClick={save} disabled={busy} className="bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-50 w-full sm:w-auto">
            {busy ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </SettingsLayout>
  );
}

export const getServerSideProps = withI18n(['permissions'])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };
  const g = (await prisma.group.findUnique({
    where: { id: gate.vis.groupId as string },
    select: {
      perm_standard_edit_pricing: true, perm_standard_diary_entries: true, perm_standard_view_invoices: true,
      perm_manager_see_values: true, perm_manager_see_margin: true,
      perm_standard_see_values: true, perm_standard_see_margin: true,
    },
  })) as any;
  return {
    props: {
      standardEditPricing: !!g?.perm_standard_edit_pricing,
      standardDiaryEntries: !!g?.perm_standard_diary_entries,
      standardViewInvoices: !!g?.perm_standard_view_invoices,
      managerSeeValues: !!g?.perm_manager_see_values,
      managerSeeMargin: !!g?.perm_manager_see_margin,
      standardSeeValues: !!g?.perm_standard_see_values,
      standardSeeMargin: !!g?.perm_standard_see_margin,
    },
  };
});
