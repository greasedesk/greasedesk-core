/**
 * File: pages/admin/jobcards/[id].tsx
 * The job card as a tabbed, stage-gated process path (Customer Details → Quote → Intake → In-Job →
 * Completion → Invoice). SSR reads the card scoped to the caller's visible sites, resolves the CURRENT
 * owner via the VehicleOwnership edge (car-first spine — not the card's frozen customer_id), computes
 * each tab's {reachable, complete} via the gating chokepoint, and loads the audit trail. All
 * interaction lives in JobCardWorkspace; the same chokepoint guards the APIs, so greying can't lie.
 */
import React from 'react';
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
import JobCardWorkspace, { CardBooking } from '@/components/jobcard/JobCardWorkspace';
import { AuditEvent } from '@/components/jobcard/JobCardAudit';
import { JobStatus, StageKey } from '@/lib/jobcard-status';
import { computeTabs, TabKey, TabState } from '@/lib/jobcard-tabs';
import { parseBreaks, Break } from '@/lib/occupancy';

type PageProps = {
  registration: string;
  createdAt: string;
  status: JobStatus;
  jobCardId: string;
  canEdit: boolean;
  canEditPricing: boolean;
  canOperate: boolean;
  currency: string;
  locale: string;
  vatRate: number;
  vatRegistered: boolean;
  owner: { name: string; phone: string | null; email: string | null; address: string | null };
  vehicle: { registration: string; vin: string | null; mileageIn: number | null; mileageOut: number | null };
  flags: string[];
  garageNotes: string;
  lines: EstimateLine[];
  catalogue: CatalogueLite[];
  fixedServices: FixedServiceLite[];
  tiers: TierLite[];
  hasEstimate: boolean;
  resources: Array<{ id: string; name: string }>;
  booking: CardBooking;
  siteHours: { openHour: number; closeHour: number; slotMinutes: number; openDays: number[]; breaks: Break[] };
  siteId: string;
  stages: Record<StageKey, boolean>;
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
        <Link href={back.href} className="text-sm text-muted hover:text-ink">{back.label}</Link>
      </div>

      <JobCardWorkspace
        jobCardId={props.jobCardId}
        status={props.status}
        tabsState={props.tabsState}
        canManage={props.canEdit}
        canOperate={props.canOperate}
        canEditPricing={props.canEditPricing}
        owner={props.owner}
        vehicle={props.vehicle}
        flags={props.flags}
        garageNotes={props.garageNotes}
        currency={props.currency}
        locale={props.locale}
        vatRate={props.vatRate}
        vatRegistered={props.vatRegistered}
        lines={props.lines}
        catalogue={props.catalogue}
        fixedServices={props.fixedServices}
        tiers={props.tiers}
        hasEstimate={props.hasEstimate}
        resources={props.resources}
        booking={props.booking}
        siteHours={props.siteHours}
        siteId={props.siteId}
        stages={props.stages}
        invoice={props.invoice}
        events={props.events}
      />
    </>
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

  const row = (await prisma.jobCard.findFirst({
    where: { id, site_id: { in: vis.siteIds } },
    include: {
      customer: { select: { name: true, phone: true, email: true } },
      vehicle: { select: { id: true, registration: true, vin: true, mileage_at_create: true } },
      items: { orderBy: { created_at: 'asc' } },
    },
  })) as any;
  if (!row) return { notFound: true };

  const site = (await prisma.site.findUnique({ where: { id: row.site_id }, select: { currency_code: true, locale: true, open_hour: true, close_hour: true, booking_slot_minutes: true, open_days: true, breaks: true } })) as { currency_code: string; locale: string; open_hour: number; close_hour: number; booking_slot_minutes: number; open_days: number[]; breaks: unknown } | null;
  const canEdit = canManageSite(vis, row.site_id);
  const canOperate = canAccessSite(vis, row.site_id);
  const perms = await getTenantPermissions(user.group_id as string);
  const canEditPricing = canEditEstimate(vis, row.site_id, perms);
  const vat = await getTenantVat(user.group_id as string);

  // CAR-FIRST: resolve the CURRENT owner via the ownership edge (falls back to the card's own customer
  // link only if a card somehow predates its vehicle's edge — the backfill covered all live vehicles).
  const edgeOwnerId = row.vehicle?.id ? await getCurrentOwnerId(prisma, row.vehicle.id as string) : null;
  const ownerRow = edgeOwnerId
    ? (await prisma.customer.findUnique({ where: { id: edgeOwnerId }, select: { name: true, phone: true, email: true, address: true } }))
    : (row.customer ?? null);
  const owner = { name: ownerRow?.name ?? '—', phone: ownerRow?.phone ?? null, email: ownerRow?.email ?? null, address: (ownerRow as any)?.address ?? null };

  const resources = ((await prisma.resource.findMany({
    where: { site_id: row.site_id, is_active: true },
    orderBy: { display_order: 'asc' },
    select: { id: true, name: true },
  })) as Array<{ id: string; name: string }>);
  const booking: CardBooking = (row.resource_id && row.start_at && row.end_at)
    ? {
        resourceId: row.resource_id,
        startAt: (row.start_at as Date).toISOString(),
        endAt: (row.end_at as Date).toISOString(),
        heldOnLift: !!row.held_on_lift,
        // duration is the source of truth; fall back to (end - start) for pre-backfill rows.
        workingMinutes: row.booking_duration_minutes ?? Math.round(((row.end_at as Date).getTime() - (row.start_at as Date).getTime()) / 60000),
      }
    : null;

  const invoiceRow = (await prisma.invoice.findUnique({ where: { job_card_id: row.id }, select: { id: true, invoice_number: true } })) as { id: string; invoice_number: string | null } | null;
  const invoice = invoiceRow ? { id: invoiceRow.id, number: invoiceRow.invoice_number ?? '' } : null;

  const num = (d: any) => (d == null ? 0 : Number(d));
  const [catalogueRows, tierRows] = await Promise.all([
    prisma.catalogueItem.findMany({
      where: { group_id: user.group_id, active: true },
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, title: true, name: true, item_type: true, unit_cost: true, unit_price: true, vat_rate: true, base_price_ex_vat: true,
        components: { orderBy: { position: 'asc' }, select: { description: true, qty: true, unit_cost_ex_vat: true } },
        tier_prices: { select: { tier_id: true, price_ex_vat: true } },
      },
    }) as Promise<any[]>,
    prisma.serviceTier.findMany({ where: { group_id: user.group_id, active: true }, orderBy: [{ position: 'asc' }, { created_at: 'asc' }], select: { id: true, name: true } }) as Promise<any[]>,
  ]);
  const catalogue: CatalogueLite[] = catalogueRows.filter((c) => c.item_type !== 'fixed').map((c) => ({
    id: c.id, code: c.code, name: c.name, item_type: c.item_type,
    unit_cost: Number(c.unit_cost), unit_price: Number(c.unit_price), vat_rate: Number(c.vat_rate),
  }));
  const codeById = new Map(catalogue.map((c) => [c.id, c.code]));
  const fixedServices: FixedServiceLite[] = catalogueRows.filter((c) => c.item_type === 'fixed').map((c) => ({
    id: c.id, code: c.code, title: c.title, name: c.name,
    basePriceExVat: Number(c.base_price_ex_vat ?? c.unit_price), vatRate: Number(c.vat_rate),
    components: c.components.map((x: any) => ({ description: x.description, qty: Number(x.qty), unitCost: Number(x.unit_cost_ex_vat) })),
    tierPrices: c.tier_prices.map((tp: any) => ({ tierId: tp.tier_id, priceExVat: tp.price_ex_vat == null ? null : Number(tp.price_ex_vat) })),
  }));
  const tiers: TierLite[] = tierRows.map((tt) => ({ id: tt.id, name: tt.name }));

  const lines: EstimateLine[] = (row.items as any[]).map((it) => ({
    item_type: it.item_type,
    description: it.description ?? '',
    qty: String(num(it.qty)),
    unit_price: String(num(it.unit_price)),
    unit_cost: num(it.unit_cost) ? String(num(it.unit_cost)) : '',
    vatable: num(it.vat_rate) > 0,
    code: it.catalogue_item_id ? (codeById.get(it.catalogue_item_id) ?? '') : '',
    catalogue_item_id: it.catalogue_item_id ?? null,
  }));

  const flags = [
    row.flag_urgent && 'urgent', row.flag_sales_car && 'sales', row.flag_customer_car && 'customer',
    row.flag_mot && 'mot', row.flag_diag && 'diag',
  ].filter(Boolean) as string[];

  const stages: Record<StageKey, boolean> = {
    details: !!row.stage_details_done, intake: !!row.stage_intake_done,
    injob: !!row.stage_injob_done, complete: !!row.stage_complete_done,
  };
  const tabsState = computeTabs({
    status: row.status as JobStatus,
    stages,
    hasOwner: !!edgeOwnerId || !!row.customer,
    hasRegistration: !!(row.vehicle?.registration && String(row.vehicle.registration).trim()),
  });

  // Audit trail — this card's events, newest first. Empty for cards created before this shipped.
  const auditRows = (await prisma.auditLog.findMany({
    where: { entity: 'job_card', entity_id: row.id },
    orderBy: { created_at: 'desc' },
    take: 100,
    select: { id: true, action: true, created_at: true, user: { select: { name: true, email: true } } },
  })) as any[];
  const events: AuditEvent[] = auditRows.map((a) => ({
    id: a.id, action: a.action, actor: a.user?.name ?? a.user?.email ?? null, at: (a.created_at as Date).toISOString(),
  }));

  return {
    props: {
      registration: row.vehicle?.registration ?? '—',
      createdAt: row.created_at.toISOString(),
      status: row.status,
      jobCardId: row.id,
      canEdit, canEditPricing, canOperate,
      currency: site?.currency_code ?? 'GBP',
      locale: site?.locale ?? 'en-GB',
      vatRate: lines.length > 0 ? num(row.vat_rate) : vat.defaultRate,
      vatRegistered: vat.registered,
      owner,
      vehicle: {
        registration: row.vehicle?.registration ?? '—',
        vin: row.vehicle?.vin ?? null,
        mileageIn: row.odometer_in ?? row.vehicle?.mileage_at_create ?? null,
        mileageOut: row.odometer_out ?? null,
      },
      flags,
      garageNotes: row.garage_notes ?? '',
      lines, catalogue, fixedServices, tiers,
      hasEstimate: (row.items as any[]).length > 0,
      resources, booking, stages, tabsState, invoice, events,
      siteHours: { openHour: site?.open_hour ?? 8, closeHour: site?.close_hour ?? 18, slotMinutes: site?.booking_slot_minutes ?? 30, openDays: site?.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6], breaks: parseBreaks(site?.breaks) },
      siteId: row.site_id,
    },
  };
});
