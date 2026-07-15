/**
 * File: lib/tenant-purge.ts
 * SuperAdmin tenant lifecycle: archive (soft, reversible), un-archive, and PURGE (hard, ordered).
 *
 * PURGE is an ORDERED TRANSACTION, never a cascade (step-0 blast-radius rules):
 *   1. Cancel the Stripe subscription FIRST (idempotent) — a deleted tenant must never still bill.
 *   2. R2: delete every object under `${groupId}/` (list + batched delete).
 *   3. DB innermost-first past the NoAction FKs (Booking / JobCard / Invoice block a bare cascade):
 *        Invoice (→InvoiceLine cascade) → Booking → JobCard (→photos/items cascade)
 *        → explicit User delete (group_id is SetNull → cascade would ORPHAN PII; GDPR-critical;
 *          →Account/Session/UserSite cascade off User)
 *        → explicit UploadTelemetry + VinReadShadow (no FK — cascade misses them)
 *        → group.delete() (cascades the entire remainder: Sites+children, catalogue, promos,
 *          cost, leave, invoices-seq, roles, billing, …).
 *   4. Write a SuperAdminAudit row (its own table — survives the purge).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { deleteByPrefix } from '@/lib/r2';

export type PurgeResult = {
  groupId: string;
  nameSnapshot: string;
  refSnapshot: string | null;
  stripe: { subscriptionId: string | null; canceled: boolean; note?: string };
  r2: { deleted: number };
  before: Record<string, number>;
  after: Record<string, number>;
  auditId: string;
};

/** Comprehensive tenant row-count across every table holding this tenant's data (direct group_id,
 *  site-scoped, and child tables reached via relation). Used before + after to PROVE zero remain. */
export async function countTenantRows(groupId: string): Promise<Record<string, number>> {
  const [
    users, sites, siteFeatures, profitCentres, resources, userSites, roles, groupFeatures, groupBilling,
    customers, vehicles, vehicleIdentities, vehicleOwnerships, serviceCatalogue, partCatalogue, taxRates,
    bookings, jobCards, jobCardPhotos, jobCardItems, diaryNotes, auditLogs,
    invoices, invoiceLines, invoiceSequence, paymentMethods,
    catalogueItems, catalogueComponents, catalogueTierPrices, serviceTiers, promos, promoTargets,
    costPeople, overheads, costAllocations, leaveRecords, publicHolidays, employmentEvents,
    vinReadShadow, uploadTelemetry,
  ] = await Promise.all([
    prisma.user.count({ where: { group_id: groupId } }),
    prisma.site.count({ where: { group_id: groupId } }),
    prisma.siteFeature.count({ where: { site: { group_id: groupId } } }),
    prisma.profitCentre.count({ where: { site: { group_id: groupId } } }),
    prisma.resource.count({ where: { site: { group_id: groupId } } }),
    prisma.userSite.count({ where: { site: { group_id: groupId } } }),
    prisma.role.count({ where: { group_id: groupId } }),
    prisma.groupFeature.count({ where: { group_id: groupId } }),
    prisma.groupBilling.count({ where: { group_id: groupId } }),
    prisma.customer.count({ where: { group_id: groupId } }),
    prisma.vehicle.count({ where: { group_id: groupId } }),
    prisma.vehicleIdentity.count({ where: { group_id: groupId } }),
    prisma.vehicleOwnership.count({ where: { vehicle: { group_id: groupId } } }),
    prisma.serviceCatalogue.count({ where: { group_id: groupId } }),
    prisma.partCatalogue.count({ where: { group_id: groupId } }),
    prisma.taxRate.count({ where: { group_id: groupId } }),
    prisma.booking.count({ where: { group_id: groupId } }),
    prisma.jobCard.count({ where: { group_id: groupId } }),
    prisma.jobCardPhoto.count({ where: { job_card: { group_id: groupId } } }),
    prisma.jobCardItem.count({ where: { job_card: { group_id: groupId } } }),
    prisma.diaryNote.count({ where: { group_id: groupId } }),
    prisma.auditLog.count({ where: { group_id: groupId } }),
    prisma.invoice.count({ where: { group_id: groupId } }),
    prisma.invoiceLine.count({ where: { invoice: { group_id: groupId } } }),
    prisma.invoiceSequence.count({ where: { group_id: groupId } }),
    prisma.paymentMethod.count({ where: { group_id: groupId } }),
    prisma.catalogueItem.count({ where: { group_id: groupId } }),
    prisma.catalogueComponent.count({ where: { item: { group_id: groupId } } }),
    prisma.catalogueItemTierPrice.count({ where: { item: { group_id: groupId } } }),
    prisma.serviceTier.count({ where: { group_id: groupId } }),
    prisma.promo.count({ where: { group_id: groupId } }),
    prisma.promoTarget.count({ where: { promo: { group_id: groupId } } }),
    prisma.costPerson.count({ where: { group_id: groupId } }),
    prisma.overhead.count({ where: { group_id: groupId } }),
    prisma.costAllocation.count({ where: { group_id: groupId } }),
    prisma.leaveRecord.count({ where: { group_id: groupId } }),
    prisma.publicHoliday.count({ where: { group_id: groupId } }),
    prisma.employmentEvent.count({ where: { group_id: groupId } }),
    prisma.vinReadShadow.count({ where: { group_id: groupId } }),
    prisma.uploadTelemetry.count({ where: { group_id: groupId } }),
  ]);
  const groups = await prisma.group.count({ where: { id: groupId } });
  return {
    Group: groups, User: users, Site: sites, SiteFeature: siteFeatures, ProfitCentre: profitCentres, Resource: resources,
    UserSite: userSites, Role: roles, GroupFeature: groupFeatures, GroupBilling: groupBilling,
    Customer: customers, Vehicle: vehicles, VehicleIdentity: vehicleIdentities, VehicleOwnership: vehicleOwnerships,
    ServiceCatalogue: serviceCatalogue, PartCatalogue: partCatalogue, TaxRate: taxRates,
    Booking: bookings, JobCard: jobCards, JobCardPhoto: jobCardPhotos, JobCardItem: jobCardItems, DiaryNote: diaryNotes, AuditLog: auditLogs,
    Invoice: invoices, InvoiceLine: invoiceLines, InvoiceSequence: invoiceSequence, PaymentMethod: paymentMethods,
    CatalogueItem: catalogueItems, CatalogueComponent: catalogueComponents, CatalogueItemTierPrice: catalogueTierPrices,
    ServiceTier: serviceTiers, Promo: promos, PromoTarget: promoTargets,
    CostPerson: costPeople, Overhead: overheads, CostAllocation: costAllocations,
    LeaveRecord: leaveRecords, PublicHoliday: publicHolidays, EmploymentEvent: employmentEvents,
    VinReadShadow: vinReadShadow, UploadTelemetry: uploadTelemetry,
  };
}

export async function archiveTenant(operatorUserId: string, groupId: string): Promise<{ archivedAt: Date; auditId: string }> {
  const g = await prisma.group.update({ where: { id: groupId }, data: { archived_at: new Date() }, select: { archived_at: true, group_name: true, ref: true } });
  const audit = await prisma.superAdminAudit.create({ data: { operator_user_id: operatorUserId, action: 'tenant.archived', target_group_id: groupId, target_name_snapshot: g.group_name, target_ref_snapshot: g.ref } });
  return { archivedAt: g.archived_at as Date, auditId: audit.id };
}

export async function unarchiveTenant(operatorUserId: string, groupId: string): Promise<{ auditId: string }> {
  const g = await prisma.group.update({ where: { id: groupId }, data: { archived_at: null }, select: { group_name: true, ref: true } });
  const audit = await prisma.superAdminAudit.create({ data: { operator_user_id: operatorUserId, action: 'tenant.unarchived', target_group_id: groupId, target_name_snapshot: g.group_name, target_ref_snapshot: g.ref } });
  return { auditId: audit.id };
}

export async function purgeTenant(operatorUserId: string, groupId: string): Promise<PurgeResult> {
  const g = await prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true, ref: true, billing: { select: { stripe_subscription_id: true } } } });
  if (!g) throw new Error('Tenant not found.');
  const before = await countTenantRows(groupId);

  // 1. Stripe FIRST — a purged tenant must never still bill. Idempotent.
  const subId = g.billing?.stripe_subscription_id ?? null;
  const stripeResult = { subscriptionId: subId, canceled: false, note: undefined as string | undefined };
  if (subId) {
    const stripe = getStripe();
    if (stripe) {
      try { const s = await stripe.subscriptions.cancel(subId); stripeResult.canceled = s.status === 'canceled'; }
      catch (e: any) { stripeResult.note = e?.code === 'resource_missing' ? 'already gone' : (e?.message || 'cancel error'); stripeResult.canceled = e?.code === 'resource_missing'; }
    } else { stripeResult.note = 'stripe not configured'; }
  }

  // 2. R2 — every object under the tenant prefix.
  const r2 = await deleteByPrefix(`${groupId}/`);

  // 3. DB — ordered, past the NoAction FKs, in ONE transaction.
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.invoice.deleteMany({ where: { group_id: groupId } });      // → InvoiceLine cascades
    await tx.booking.deleteMany({ where: { group_id: groupId } });
    await tx.jobCard.deleteMany({ where: { group_id: groupId } });      // → JobCardPhoto/Item cascade
    await tx.user.deleteMany({ where: { group_id: groupId } });         // EXPLICIT (SetNull would orphan PII) → Account/Session/UserSite cascade
    await tx.uploadTelemetry.deleteMany({ where: { group_id: groupId } }); // no FK — cascade misses
    await tx.vinReadShadow.deleteMany({ where: { group_id: groupId } });   // no FK — cascade misses
    await tx.group.delete({ where: { id: groupId } });                 // cascades the entire remainder
  });

  const after = await countTenantRows(groupId);

  // 4. Audit — its own table, survives the purge.
  const audit = await prisma.superAdminAudit.create({
    data: {
      operator_user_id: operatorUserId, action: 'tenant.purged', target_group_id: groupId,
      target_name_snapshot: g.group_name, target_ref_snapshot: g.ref,
      detail: { before, after, r2Deleted: r2.deleted, stripe: stripeResult } as any,
    },
  });

  return { groupId, nameSnapshot: g.group_name, refSnapshot: g.ref, stripe: stripeResult, r2, before, after, auditId: audit.id };
}
