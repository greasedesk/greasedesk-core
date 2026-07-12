/**
 * File: pages/admin/jobcards/[id].tsx
 * The job card as a tabbed, stage-gated process path (Customer Details → Quote → Intake → In-Job →
 * Completion → Invoice). SSR reads the card scoped to the caller's visible sites, resolves the CURRENT
 * owner via the VehicleOwnership edge (car-first spine — not the card's frozen customer_id), computes
 * each tab's {reachable, complete} via the gating chokepoint, and loads the audit trail. All
 * interaction lives in JobCardWorkspace; the same chokepoint guards the APIs, so greying can't lie.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite, canAccessSite } from '@/lib/admin-guard';
import { getTenantPermissions, canEditEstimate } from '@/lib/permissions';
import { getTenantVat } from '@/lib/tenant-vat';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { withI18n } from '@/lib/gssp-i18n';
import { EstimateLine, CatalogueLite, FixedServiceLite, TierLite } from '@/components/jobcard/EstimateBuilder';
import { PromoLite } from '@/lib/promo';
import JobCardWorkspace, { CardBooking } from '@/components/jobcard/JobCardWorkspace';
import { AuditEvent } from '@/components/jobcard/JobCardAudit';
import { JobStatus, StageKey } from '@/lib/jobcard-status';
import { computeTabs, TabKey, TabState } from '@/lib/jobcard-tabs';
import { buildJobCardPageProps } from '@/lib/jobcard-page-data';
import { parseBreaks, Break } from '@/lib/occupancy';

type PageProps = {
  registration: string;
  createdAt: string;
  status: JobStatus;
  jobCardId: string;
  isAdmin: boolean;
  canEdit: boolean;
  canEditPricing: boolean;
  priceVisible: boolean;
  costVisible: boolean;
  canOperate: boolean;
  currency: string;
  locale: string;
  vatRate: number;
  vatRegistered: boolean;
  owner: { name: string; phone: string | null; email: string | null; address: string | null };
  vehicle: {
    registration: string; vin: string | null; mileageIn: number | null; mileageOut: number | null;
    make: string | null; model: string | null; colour: string | null; year: number | null; fuel: string | null; engineCc: number | null;
    motExpiry: string | null; lastMotMileage: number | null; lastMotDate: string | null;
  };
  flags: string[];
  isComeback: boolean;
  garageNotes: string;
  lines: EstimateLine[];
  catalogue: CatalogueLite[];
  fixedServices: FixedServiceLite[];
  tiers: TierLite[];
  promos: PromoLite[];
  hasEstimate: boolean;
  resources: Array<{ id: string; name: string }>;
  booking: CardBooking;
  siteHours: { openHour: number; closeHour: number; slotMinutes: number; openDays: number[]; breaks: Break[] };
  siteId: string;
  stages: Record<StageKey, boolean>;
  skipped: { intake: boolean; injob: boolean; complete: boolean };
  tabsState: Record<TabKey, TabState>;
  invoice: { id: string; number: string } | null;
  events: AuditEvent[];
};

export default function JobCardDetailPage(props: PageProps) {
  const router = useRouter();
  const { t } = useTranslation('jobcard');
  const q = router.query;
  const back = q.from === 'diary'
    ? { href: `/admin/diary?site=${q.site ?? ''}&view=${q.view ?? 'week'}&date=${q.date ?? ''}`, label: t('back.diary') }
    : { href: '/admin/jobcards', label: t('back.list') };
  return (
    <>
      <Head><title>Job Card {props.registration} - GreaseDesk</title></Head>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-ink">{props.registration}</h1>
          <p className="text-muted text-sm mt-1">{t('createdAt', { when: new Date(props.createdAt).toLocaleString(props.locale) })}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {/* Mobile: a real bordered button (≥44px tap target). sm+: the same subtle text link as before. */}
          <Link
            href={back.href}
            className="text-sm inline-flex items-center justify-center min-h-[44px] px-3 rounded-lg border border-line bg-surface text-ink sm:min-h-0 sm:px-0 sm:rounded-none sm:border-0 sm:bg-transparent sm:text-muted sm:hover:text-ink"
          >
            {back.label}
          </Link>
          {props.isAdmin && <DeleteCardButton jobCardId={props.jobCardId} hasInvoice={!!props.invoice} />}
        </div>
      </div>

      <JobCardWorkspace
        jobCardId={props.jobCardId}
        status={props.status}
        tabsState={props.tabsState}
        canManage={props.canEdit}
        priceVisible={props.priceVisible}
        costVisible={props.costVisible}
        canOperate={props.canOperate}
        canEditPricing={props.canEditPricing}
        owner={props.owner}
        vehicle={props.vehicle}
        flags={props.flags}
        isComeback={props.isComeback}
        garageNotes={props.garageNotes}
        currency={props.currency}
        locale={props.locale}
        vatRate={props.vatRate}
        vatRegistered={props.vatRegistered}
        lines={props.lines}
        catalogue={props.catalogue}
        fixedServices={props.fixedServices}
        promos={props.promos}
        tiers={props.tiers}
        hasEstimate={props.hasEstimate}
        resources={props.resources}
        booking={props.booking}
        siteHours={props.siteHours}
        siteId={props.siteId}
        stages={props.stages}
        skipped={props.skipped}
        invoice={props.invoice}
        events={props.events}
      />
    </>
  );
}

// Admin-only hard-delete (distinct from cancel). Opens a confirmation MODAL that NAMES exactly what's
// destroyed — weightier than cancel because delete is irreversible. The server re-enforces admin + the
// any-invoice guard, so this UI can't authorise anything on its own.
function DeleteCardButton({ jobCardId, hasInvoice }: { jobCardId: string; hasInvoice: boolean }) {
  const { t } = useTranslation('jobcard');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (hasInvoice) {
    return <span className="text-xs text-muted" title={t('delete.invoiceBlocked')}>{t('delete.invoiceBlocked')}</span>;
  }

  async function del() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/jobcard?id=${jobCardId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data?.message || t('delete.failed')); return; }
      await router.replace('/admin/jobcards'); // await the navigation so busy holds until this dialog is gone
    } catch { setErr(t('delete.failed')); }
    finally { setBusy(false); } // a network throw must never strand the dialog (backdrop-close checks !busy)
  }

  return (
    <>
      <button onClick={() => { setErr(null); setOpen(true); }} className="text-sm text-danger hover:underline">{t('delete.button')}</button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && setOpen(false)}>
          <div className="bg-surface w-full max-w-md rounded-2xl border border-line shadow-xl p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-ink mb-2">{t('delete.confirmTitle')}</h2>
            <p className="text-sm text-muted mb-5">{t('delete.confirmBody')}</p>
            {err && <div className="bg-danger-soft text-danger rounded-lg p-2 text-sm mb-4">{err}</div>}
            <div className="flex justify-end gap-2">
              <button disabled={busy} onClick={() => setOpen(false)} className="text-sm text-muted hover:text-ink px-4 py-2">{t('delete.cancel')}</button>
              <button disabled={busy} onClick={del} className="text-sm bg-danger text-white font-semibold rounded-lg px-4 py-2 disabled:opacity-50">{busy ? t('delete.working') : t('delete.confirmYes')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export const getServerSideProps = withI18n(['jobcard'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }
  // ONE builder shared with /api/jobcard-pane (the diary's inline card) — lib/jobcard-page-data.ts.
  const props = await buildJobCardPageProps(user.id as string, user.group_id as string, ctx.params?.id as string);
  if (!props) return { notFound: true };
  return { props };
});
