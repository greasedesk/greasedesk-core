/**
 * File: lib/jobcard-page-data.ts
 * THE one builder for a job card's full workspace props — used by BOTH the standalone card page's
 * getServerSideProps AND /api/jobcard-pane (the diary's inline-card pane). One data shape, one
 * JobCardWorkspace component, so the inline card can never drift from the routed page.
 * Returns null when the card isn't visible to the caller. All values are JSON-serialisable.
 *
 * Queries run in three concurrency waves (not one-by-one) — the DB round trip is the dominant
 * cost of a card open, so depth matters: wave 1 = everything keyed on the params alone,
 * wave 2 = the card row (needs the visibility filter), wave 3 = everything keyed on the row.
 */
import { prisma } from '@/lib/db';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite, canAccessSite } from '@/lib/admin-guard';
import { getTenantPermissions, canEditEstimate } from '@/lib/permissions';
import { getTenantVat } from '@/lib/tenant-vat';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { computeTabs } from '@/lib/jobcard-tabs';
import { parseBreaks } from '@/lib/occupancy';
import type { JobStatus, StageKey } from '@/lib/jobcard-status';
import type { EstimateLine, CatalogueLite, FixedServiceLite, TierLite } from '@/components/jobcard/EstimateBuilder';
import type { PromoLite } from '@/lib/promo';
import type { CardBooking } from '@/components/jobcard/JobCardWorkspace';
import type { AuditEvent } from '@/components/jobcard/JobCardAudit';

export async function buildJobCardPageProps(userId: string, groupId: string, cardId: string) {
  // Wave 1 — param-keyed queries, all fired together. Invoice + audit key on the cardId param
  // (not the fetched row), so they can start now; if the card turns out to be invisible their
  // results are simply discarded (nothing is returned).
  const [vis, perms, vat, invoiceRow, [catalogueRows, tierRows, promoRows], auditRows] = await Promise.all([
    getVisibility(userId),
    getTenantPermissions(groupId),
    getTenantVat(groupId),
    prisma.invoice.findUnique({ where: { job_card_id: cardId }, select: { id: true, invoice_number: true } }) as Promise<{ id: string; invoice_number: string | null } | null>,
    Promise.all([
      prisma.catalogueItem.findMany({
        where: { group_id: groupId, active: true },
        orderBy: { code: 'asc' },
        select: {
          id: true, code: true, title: true, name: true, item_type: true, unit_cost: true, unit_price: true, vat_rate: true, base_price_ex_vat: true,
          components: { orderBy: { position: 'asc' }, select: { description: true, qty: true, unit_cost_ex_vat: true } },
          tier_prices: { select: { tier_id: true, price_ex_vat: true } },
        },
      }) as Promise<any[]>,
      prisma.serviceTier.findMany({ where: { group_id: groupId, active: true }, orderBy: [{ position: 'asc' }, { created_at: 'asc' }], select: { id: true, name: true } }) as Promise<any[]>,
      prisma.promo.findMany({ where: { group_id: groupId, active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, label: true, promo_type: true, amount: true, targets: { select: { item: { select: { id: true, title: true, name: true } } } } } }) as Promise<any[]>,
    ]),
    prisma.auditLog.findMany({
      where: { entity: 'job_card', entity_id: cardId },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: { id: true, action: true, created_at: true, user: { select: { name: true, email: true } } },
    }) as Promise<any[]>,
  ]);

  // Wave 2 — the card row (must wait for visibility: the site filter IS the access control).
  const row = (await prisma.jobCard.findFirst({
    where: { id: cardId, site_id: { in: vis.siteIds } },
    include: {
      customer: { select: { name: true, phone: true, email: true } },
      vehicle: { select: { id: true, registration: true, vin: true, mileage_at_create: true, make: true, model: true, colour: true, year: true, fuel_type: true, engine_cc: true, mot_expiry: true, last_mot_mileage: true, last_mot_date: true } },
      items: { orderBy: { created_at: 'asc' } },
    },
  })) as any;
  if (!row) return null;

  // Wave 3 — row-keyed queries, fired together. The owner chain keeps its internal order:
  // CAR-FIRST — resolve the CURRENT owner via the ownership edge (falls back to the card's own
  // customer link only if a card somehow predates its vehicle's edge — the backfill covered all
  // live vehicles).
  const [site, resources, { edgeOwnerId, ownerRow }] = await Promise.all([
    prisma.site.findUnique({ where: { id: row.site_id }, select: { currency_code: true, locale: true, open_hour: true, close_hour: true, booking_slot_minutes: true, open_days: true, breaks: true } }) as Promise<{ currency_code: string; locale: string; open_hour: number; close_hour: number; booking_slot_minutes: number; open_days: number[]; breaks: unknown } | null>,
    prisma.resource.findMany({
      where: { site_id: row.site_id, is_active: true },
      orderBy: { display_order: 'asc' },
      select: { id: true, name: true },
    }) as Promise<Array<{ id: string; name: string }>>,
    (async () => {
      const ownerId = row.vehicle?.id ? await getCurrentOwnerId(prisma, row.vehicle.id as string) : null;
      const or = ownerId
        ? await prisma.customer.findUnique({ where: { id: ownerId }, select: { name: true, phone: true, email: true, address: true } })
        : (row.customer ?? null);
      return { edgeOwnerId: ownerId, ownerRow: or };
    })(),
  ]);
  const canEdit = canManageSite(vis, row.site_id);
  const canOperate = canAccessSite(vis, row.site_id);
  const canEditPricing = canEditEstimate(vis, row.site_id, perms);
  const owner = { name: ownerRow?.name ?? '—', phone: ownerRow?.phone ?? null, email: ownerRow?.email ?? null, address: (ownerRow as any)?.address ?? null };

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

  const invoice = invoiceRow ? { id: invoiceRow.id, number: invoiceRow.invoice_number ?? '' } : null;

  const num = (d: any) => (d == null ? 0 : Number(d));
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
  const promos: PromoLite[] = promoRows.map((p) => ({ id: p.id, code: p.code, label: p.label, type: p.promo_type, amount: Number(p.amount), targets: p.targets.map((t: any) => ({ id: t.item.id, title: t.item.title || t.item.name })) }));

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
  const skipped = { intake: !!row.stage_intake_skipped, injob: !!row.stage_injob_skipped, complete: !!row.stage_complete_skipped };
  const tabsState = computeTabs({
    status: row.status as JobStatus,
    stages,
    skipped,
    hasOwner: !!edgeOwnerId || !!row.customer,
    hasRegistration: !!(row.vehicle?.registration && String(row.vehicle.registration).trim()),
  });

  // Audit trail — this card's events, newest first. Empty for cards created before this shipped.
  const events: AuditEvent[] = auditRows.map((a) => ({
    id: a.id, action: a.action, actor: a.user?.name ?? a.user?.email ?? null, at: (a.created_at as Date).toISOString(),
  }));

  return {
    registration: row.vehicle?.registration ?? '—',
    createdAt: row.created_at.toISOString(),
    status: row.status,
    jobCardId: row.id,
    canEdit, canEditPricing, canOperate,
    isAdmin: vis.isAdmin,
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
      make: row.vehicle?.make ?? null,
      model: row.vehicle?.model ?? null,
      colour: row.vehicle?.colour ?? null,
      year: row.vehicle?.year ?? null,
      fuel: row.vehicle?.fuel_type ?? null,
      engineCc: row.vehicle?.engine_cc ?? null,
      motExpiry: row.vehicle?.mot_expiry ? (row.vehicle.mot_expiry as Date).toISOString().slice(0, 10) : null,
      lastMotMileage: row.vehicle?.last_mot_mileage ?? null,
      lastMotDate: row.vehicle?.last_mot_date ? (row.vehicle.last_mot_date as Date).toISOString().slice(0, 10) : null,
    },
    flags, isComeback: !!row.is_comeback,
    garageNotes: row.garage_notes ?? '',
    lines, catalogue, fixedServices, tiers, promos,
    hasEstimate: (row.items as any[]).length > 0,
    resources, booking, stages, skipped, tabsState, invoice, events,
    siteHours: { openHour: site?.open_hour ?? 8, closeHour: site?.close_hour ?? 18, slotMinutes: site?.booking_slot_minutes ?? 30, openDays: site?.open_days && site.open_days.length ? site.open_days : [1, 2, 3, 4, 5, 6], breaks: parseBreaks(site?.breaks) },
    siteId: row.site_id,
  };
}

export type JobCardPageProps = NonNullable<Awaited<ReturnType<typeof buildJobCardPageProps>>>;
