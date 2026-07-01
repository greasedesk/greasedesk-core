/**
 * File: pages/admin/jobcards/[id].tsx
 * Slice 1: view a single job card.
 *
 * SSR read scoped to the session's group_id (ownership enforced via findFirst on
 * id + group_id). A card belonging to another tenant returns 404, never leaks.
 */
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import AdminLayout from '@/components/layout/AdminLayout';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite, canAccessSite } from '@/lib/admin-guard';
import { getTenantPermissions, canEditEstimate } from '@/lib/permissions';
import { withI18n } from '@/lib/gssp-i18n';
import EstimateBuilder, { EstimateLine } from '@/components/jobcard/EstimateBuilder';
import JobCardStatus from '@/components/jobcard/JobCardStatus';
import JobCardBooking, { CardBooking } from '@/components/jobcard/JobCardBooking';
import JobCardNotes from '@/components/jobcard/JobCardNotes';
import { JobStatus, StageKey } from '@/lib/jobcard-status';

type Flag = { label: string; on: boolean };

type CardProps = {
  id: string;
  status: JobStatus;
  createdAt: string;
  registration: string;
  vin: string | null;
  mileage: number | null;
  customerName: string;
  phone: string | null;
  email: string | null;
  flags: Flag[];
};

type PageProps = {
  card: CardProps;
  jobCardId: string;
  canEdit: boolean;         // commercial: status + booking (canManageSite)
  canEditPricing: boolean;  // estimate editing (canManageSite OR STANDARD + pricing toggle)
  canOperate: boolean;
  currency: string;
  locale: string;
  vatRate: number;
  lines: EstimateLine[];
  stages: Record<StageKey, boolean>;
  hasEstimate: boolean;
  resources: Array<{ id: string; name: string }>;
  booking: CardBooking;
  garageNotes: string;
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted mb-1">{label}</div>
      <div className="text-ink">{value || '—'}</div>
    </div>
  );
}

export default function JobCardDetailPage({ card, jobCardId, canEdit, canEditPricing, canOperate, currency, locale, vatRate, lines, stages, hasEstimate, resources, booking, garageNotes }: PageProps) {
  const router = useRouter();
  const { t } = useTranslation('jobcard');
  // Context-aware back link: return to wherever the card was opened from (diary preserves week/day+date).
  const q = router.query;
  const back = q.from === 'diary'
    ? { href: `/admin/diary?site=${q.site ?? ''}&view=${q.view ?? 'week'}&date=${q.date ?? ''}`, label: t('back.diary') }
    : { href: '/admin/jobcards', label: t('back.list') };
  return (
    <AdminLayout>
      <Head>
        <title>Job Card {card.registration} - GreaseDesk</title>
      </Head>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-ink">{card.registration}</h1>
          <p className="text-muted text-sm mt-1">Created {new Date(card.createdAt).toLocaleString('en-GB')}</p>
        </div>
        <Link href={back.href} className="text-sm text-muted hover:text-ink">
          {back.label}
        </Link>
      </div>

      {/* Lifecycle status + the four operational stage toggles */}
      <JobCardStatus
        jobCardId={jobCardId}
        status={card.status}
        stages={stages}
        hasEstimate={hasEstimate}
        canManage={canEdit}
        canOperate={canOperate}
      />

      {/* Booking — schedule onto the diary (same storage + double-booking guard) */}
      <JobCardBooking jobCardId={jobCardId} canManage={canEdit} resources={resources} booking={booking} />

      {/* Vehicle + customer */}
      <div className="bg-surface border border-line rounded-xl p-5 mb-5">
        <h2 className="text-lg font-semibold text-ink mb-4">Vehicle &amp; Customer</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Registration" value={card.registration} />
          <Field label="VIN" value={card.vin} />
          <Field label="Mileage" value={card.mileage != null ? card.mileage.toLocaleString('en-GB') : null} />
          <Field label="Customer" value={card.customerName} />
          <Field label="Phone" value={card.phone} />
          <Field label="Email" value={card.email} />
        </div>
      </div>

      {/* Flags */}
      <div className="bg-surface border border-line rounded-xl p-5">
        <h2 className="text-lg font-semibold text-ink mb-3">Flags</h2>
        {card.flags.some((f) => f.on) ? (
          <div className="flex flex-wrap gap-2">
            {card.flags
              .filter((f) => f.on)
              .map((f) => (
                <span key={f.label} className="text-sm px-3 py-1 rounded-lg bg-accent text-white border border-accent">
                  {f.label}
                </span>
              ))}
          </div>
        ) : (
          <p className="text-muted text-sm">No flags set.</p>
        )}
      </div>

      {/* Garage notes (operational — any site-assigned user) */}
      <div className="mt-5" />
      <JobCardNotes jobCardId={jobCardId} canEdit={canOperate} initialNotes={garageNotes} />

      {/* Estimate / quote builder (i18n-native; money via formatMoney) */}
      <EstimateBuilder
        jobCardId={jobCardId}
        canEdit={canEditPricing}
        currency={currency}
        locale={locale}
        initialVatRate={vatRate}
        initialLines={lines}
      />
    </AdminLayout>
  );
}

export const getServerSideProps = withI18n(['jobcard'])(async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id || !user?.site_id) {
    return { redirect: { destination: '/admin/login', permanent: false } };
  }

  const id = ctx.params?.id as string;
  const vis = await getVisibility(user.id as string);

  // Visibility: only resolve a card on a site the caller may access (else 404, no leak).
  const row = (await prisma.jobCard.findFirst({
    where: { id, site_id: { in: vis.siteIds } },
    include: {
      customer: { select: { name: true, phone: true, email: true } },
      vehicle: { select: { registration: true, vin: true, mileage_at_create: true } },
      items: { orderBy: { created_at: 'asc' } },
    },
  })) as any;

  if (!row) return { notFound: true };

  // Money formats against the card's site; editing pricing requires site authority (else view-only).
  const site = (await prisma.site.findUnique({ where: { id: row.site_id }, select: { currency_code: true, locale: true } })) as { currency_code: string; locale: string } | null;
  const canEdit = canManageSite(vis, row.site_id);     // commercial (status/lifecycle/booking)
  const canOperate = canAccessSite(vis, row.site_id);  // operational (stage toggles, start work, notes)
  const perms = await getTenantPermissions(user.group_id as string);
  const canEditPricing = canEditEstimate(vis, row.site_id, perms); // estimate: manager OR STANDARD+toggle

  // Lifts/resources on the card's site (for booking) + the current booking from the SAME storage the diary uses.
  const resources = ((await prisma.resource.findMany({
    where: { site_id: row.site_id, is_active: true },
    orderBy: { display_order: 'asc' },
    select: { id: true, name: true },
  })) as Array<{ id: string; name: string }>);
  const booking: CardBooking = (row.resource_id && row.start_at && row.end_at)
    ? { resourceId: row.resource_id, startAt: (row.start_at as Date).toISOString(), endAt: (row.end_at as Date).toISOString(), heldOnLift: !!row.held_on_lift }
    : null;

  const num = (d: any) => (d == null ? 0 : Number(d));
  const lines: EstimateLine[] = (row.items as any[]).map((it) => ({
    item_type: it.item_type,
    description: it.description ?? '',
    qty: String(num(it.qty)),
    unit_price: String(num(it.unit_price)),
    unit_cost: num(it.unit_cost) ? String(num(it.unit_cost)) : '',
    vatable: num(it.vat_rate) > 0,
  }));

  const card: CardProps = {
    id: row.id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    registration: row.vehicle?.registration ?? '—',
    vin: row.vehicle?.vin ?? null,
    mileage: row.odometer_in ?? row.vehicle?.mileage_at_create ?? null,
    customerName: row.customer?.name ?? '—',
    phone: row.customer?.phone ?? null,
    email: row.customer?.email ?? null,
    flags: [
      { label: 'Urgent / Priority', on: row.flag_urgent },
      { label: 'Sales Car', on: row.flag_sales_car },
      { label: 'Customer Car', on: row.flag_customer_car },
      { label: 'MOT', on: row.flag_mot },
      { label: 'DIAG', on: row.flag_diag },
    ],
  };

  return {
    props: {
      card,
      jobCardId: row.id,
      canEdit,
      canEditPricing,
      canOperate,
      currency: site?.currency_code ?? 'GBP',
      locale: site?.locale ?? 'en-GB',
      vatRate: num(row.vat_rate) || 20,
      lines,
      stages: {
        details: !!row.stage_details_done,
        intake: !!row.stage_intake_done,
        injob: !!row.stage_injob_done,
        complete: !!row.stage_complete_done,
      },
      hasEstimate: (row.items as any[]).length > 0,
      resources,
      booking,
      garageNotes: row.garage_notes ?? '',
    },
  };
});
