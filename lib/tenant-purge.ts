/**
 * File: lib/tenant-purge.ts
 * SuperAdmin tenant lifecycle: archive (soft, reversible), un-archive, and PURGE (hard, ordered).
 *
 * PURGE is an ORDERED TRANSACTION, never a cascade (step-0 blast-radius rules):
 *   1. Cancel the Stripe subscription FIRST **and CONFIRM it** — a deleted tenant must never still
 *      bill. An UNCONFIRMED cancel ABORTS the purge (see below); nothing else has run at that point,
 *      so the tenant is left exactly as it was.
 *   2. R2: delete every object under `${groupId}/` (list + batched delete).
 *   3. DB innermost-first past the NoAction FKs (Booking / JobCard / Invoice block a bare cascade):
 *        Invoice (→InvoiceLine cascade) → Booking → JobCard (→photos/items cascade)
 *        → explicit User delete (group_id is SetNull → cascade would ORPHAN PII; GDPR-critical;
 *          →Account/Session/UserSite cascade off User)
 *        → explicit UploadTelemetry + VinReadShadow (no FK — cascade misses them)
 *        → explicit SUBJECT-KEYED sweep (no FK either — see below)
 *        → group.delete() (cascades the entire remainder: Sites+children, catalogue, promos,
 *          cost, leave, invoices-seq, roles, billing, …).
 *   4. Write a SuperAdminAudit row (its own table — survives the purge).
 *
 * ── THE SUBJECT-KEYED TABLES, AND WHY A CASCADE CANNOT REACH THEM ───────────────────────────────
 * Six tables hold tenant or personal data with NO foreign key to Group, so `group.delete()` sails
 * straight past them. They were found the hard way: a tenant purged on 2026-08-09 left behind a
 * TwoFactorSecret holding a real, VERIFIED mobile number, keyed to a user that no longer existed.
 * A hard purge is our erasure mechanism; leaving a phone number behind is the one thing it must not
 * do.
 *
 *   TwoFactorSecret / DeliveredCode / TwoFactorRecoveryCode
 *        keyed by (subject_type, subject_id) — a bare string, no FK. Hold the phone number, the
 *        code destinations and the recovery-code hashes.
 *   VerificationToken
 *        `identifier` IS the email address (NextAuth's shape), so the row is PII in its own key.
 *   CountryWaitlist
 *        relates to Group as SetNull — the row SURVIVES with its email and a nulled group_id. The
 *        exact trap the User delete below already guards against, one table over.
 *   AuthRateLimit
 *        keys embed the user id, the group id and (unavoidably) raw IP addresses.
 *
 * THE SUBJECT LIST IS CAPTURED BEFORE THE TRANSACTION, and that ordering is load-bearing twice
 * over: the sweep needs the user ids AFTER the users are deleted (nothing left to enumerate), and
 * so does the after-count — recomputing it from the group would find no users, count zero
 * subject-rows, and cheerfully report a clean purge over the top of whatever remained.
 *
 * ── WHAT IS DELIBERATELY LEFT ───────────────────────────────────────────────────────────────────
 * CommissionEntry and TenantAttribution also carry group_id with no cascade, and they STAY. They
 * are our own accounts payable — what we owe a rep for the introduction — and they hold no personal
 * data about the tenant's people, only the id of a group that no longer exists, exactly as
 * SuperAdminAudit.target_group_id does. Erasing a customer must not erase our books. They are named
 * here so nobody later reads the sweep, notices the gap, and "fixes" it.
 *
 * ── WHY AN UNCONFIRMED CANCEL MUST ABORT ────────────────────────────────────────────────────────
 * `Group.billing.stripe_subscription_id` is the ONLY route from the product to the subscription.
 * Once the Group row is gone the subscription is unreachable forever: nothing can list it, stop it,
 * or even discover it. This used to record the failure in `stripe.note` and delete anyway, which in
 * test mode left nine orphans and in live would be nine real cards charged monthly for tenants that
 * no longer exist — invisible until a chargeback nobody can trace.
 *
 * CONFIRMED means exactly two things: Stripe returned status `canceled`, or Stripe said
 * `resource_missing` (it is already gone). Everything else — an API error, a network failure, an
 * unconfigured client, or a cancel that returned some other status — is UNCONFIRMED and throws,
 * naming the subscription id so an operator can finish the job in the Stripe dashboard and re-run.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { deleteByPrefix, tenantPrefix } from '@/lib/r2';
import { tenantRateLimitKeys } from '@/lib/auth-rate-limit';

/** See the note at the transaction below: the default 5s budget is not enough for a purge. */
const PURGE_TX = { maxWait: 30_000, timeout: 120_000 };

/**
 * Thrown INSTEAD of purging when the subscription cannot be confirmed stopped. Carries the
 * subscription id because that id is about to become the only way to find the thing, and if the
 * purge went ahead it would be lost with the row that holds it.
 */
export class PurgeAbortedError extends Error {
  readonly code = 'purge_aborted_stripe';
  readonly subscriptionId: string;
  // Written out rather than as a TS parameter property: this file is exercised by a plain node
  // harness in the gate, and strip-only type removal cannot desugar parameter properties.
  constructor(subscriptionId: string, reason: string) {
    super(`Purge aborted: subscription ${subscriptionId} could not be confirmed cancelled — ${reason} Cancel it in the Stripe dashboard, then purge again. Nothing has been deleted.`);
    this.name = 'PurgeAbortedError';
    this.subscriptionId = subscriptionId;
  }
}

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

/** The identifiers the subject-keyed tables are addressed by. Captured ONCE, before anything is
 *  deleted, then handed to both counts and to the sweep — see the header. */
export type PurgeSubjects = { userIds: string[]; emails: string[] };

export async function collectPurgeSubjects(groupId: string): Promise<PurgeSubjects> {
  const users = (await prisma.user.findMany({
    where: { group_id: groupId }, select: { id: true, email: true },
  })) as Array<{ id: string; email: string }>;
  return { userIds: users.map((u) => u.id), emails: users.map((u) => u.email) };
}

/** Comprehensive tenant row-count across every table holding this tenant's data (direct group_id,
 *  site-scoped, and child tables reached via relation). Used before + after to PROVE zero remain.
 *
 *  `subjects` is REQUIRED for an honest after-count: the subject-keyed tables cannot be found from
 *  the group once its users are gone, so passing them is what stops the count from reporting zero
 *  because it looked in the wrong place. */
export async function countTenantRows(groupId: string, subjects?: PurgeSubjects): Promise<Record<string, number>> {
  const [
    users, sites, siteFeatures, profitCentres, resources, userSites, roles, groupFeatures, groupBilling,
    customers, vehicles, vehicleIdentities, vehicleOwnerships, serviceCatalogue, partCatalogue, taxRates,
    bookings, jobCards, jobCardPhotos, jobCardItems, diaryNotes, auditLogs,
    invoices, invoiceLines, invoiceSequence, paymentMethods, payments, refunds,
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
    // Payment and Refund CASCADE from Group, so the purge already removes them — but the count list
    // IS the proof, and a table missing from it is a table the after-check cannot say anything
    // about. Money rows are the last thing that should be verified by assumption.
    prisma.payment.count({ where: { group_id: groupId } }),
    prisma.refund.count({ where: { group_id: groupId } }),
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

  // The six with no path back to Group. Counted by the captured identifiers, never re-derived.
  const ids = subjects?.userIds ?? [];
  const emails = subjects?.emails ?? [];
  const [twoFactorSecrets, deliveredCodes, recoveryCodes, verificationTokens, waitlist, rateLimits] = await Promise.all([
    ids.length ? prisma.twoFactorSecret.count({ where: { subject_type: 'tenant', subject_id: { in: ids } } }) : 0,
    ids.length ? prisma.deliveredCode.count({ where: { subject_type: 'tenant', subject_id: { in: ids } } }) : 0,
    ids.length ? prisma.twoFactorRecoveryCode.count({ where: { subject_type: 'tenant', subject_id: { in: ids } } }) : 0,
    emails.length ? prisma.verificationToken.count({ where: { identifier: { in: emails } } }) : 0,
    prisma.countryWaitlist.count({ where: { group_id: groupId } }),
    prisma.authRateLimit.count({ where: { key: { in: tenantRateLimitKeys(groupId, ids) } } }),
  ]);

  return {
    Group: groups, User: users, Site: sites, SiteFeature: siteFeatures, ProfitCentre: profitCentres, Resource: resources,
    UserSite: userSites, Role: roles, GroupFeature: groupFeatures, GroupBilling: groupBilling,
    Customer: customers, Vehicle: vehicles, VehicleIdentity: vehicleIdentities, VehicleOwnership: vehicleOwnerships,
    ServiceCatalogue: serviceCatalogue, PartCatalogue: partCatalogue, TaxRate: taxRates,
    Booking: bookings, JobCard: jobCards, JobCardPhoto: jobCardPhotos, JobCardItem: jobCardItems, DiaryNote: diaryNotes, AuditLog: auditLogs,
    Invoice: invoices, InvoiceLine: invoiceLines, InvoiceSequence: invoiceSequence, PaymentMethod: paymentMethods,
    Payment: payments, Refund: refunds,
    CatalogueItem: catalogueItems, CatalogueComponent: catalogueComponents, CatalogueItemTierPrice: catalogueTierPrices,
    ServiceTier: serviceTiers, Promo: promos, PromoTarget: promoTargets,
    CostPerson: costPeople, Overhead: overheads, CostAllocation: costAllocations,
    LeaveRecord: leaveRecords, PublicHoliday: publicHolidays, EmploymentEvent: employmentEvents,
    VinReadShadow: vinReadShadow, UploadTelemetry: uploadTelemetry,
    TwoFactorSecret: twoFactorSecrets, DeliveredCode: deliveredCodes, TwoFactorRecoveryCode: recoveryCodes,
    VerificationToken: verificationTokens, CountryWaitlist: waitlist, AuthRateLimit: rateLimits,
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
  // BEFORE ANYTHING. Once the users are deleted these identifiers are unrecoverable, and both the
  // sweep and the after-count are addressed by them — see the header.
  const subjects = await collectPurgeSubjects(groupId);
  const before = await countTenantRows(groupId, subjects);

  // 1. Stripe FIRST — cancel AND CONFIRM. Nothing below this point runs unless the subscription is
  // provably stopped, because after step 3 there is no way back to it (see the header).
  const subId = g.billing?.stripe_subscription_id ?? null;
  const stripeResult = { subscriptionId: subId, canceled: false, note: undefined as string | undefined };
  if (subId) {
    const stripe = getStripe();
    if (!stripe) {
      throw new PurgeAbortedError(subId, 'Stripe is not configured on this deployment, so the subscription cannot be cancelled or confirmed.');
    }
    try {
      const s = await stripe.subscriptions.cancel(subId);
      if (s.status !== 'canceled') {
        // Cancelled without ending: a schedule or a pending update can leave it live. Not confirmed.
        throw new PurgeAbortedError(subId, `Stripe returned status "${s.status}" rather than "canceled".`);
      }
      stripeResult.canceled = true;
    } catch (e: any) {
      if (e instanceof PurgeAbortedError) throw e;
      // ALREADY GONE is the one failure that IS a confirmation — there is nothing left to bill.
      if (e?.code === 'resource_missing') { stripeResult.canceled = true; stripeResult.note = 'already gone'; }
      else throw new PurgeAbortedError(subId, e?.message || 'the cancel request failed');
    }
  }

  // 2. R2 — every object under the tenant prefix.
  // The SAME rule photoKey builds against — shared, not restated. If these two ever disagreed,
  // objects would be written outside the range the purge sweeps and survive it silently.
  const r2 = await deleteByPrefix(tenantPrefix(groupId));

  // 3. DB — ordered, past the NoAction FKs, in ONE transaction.
  //
  // ── ITS OWN BUDGET, BECAUSE THE DEFAULT IS FIVE SECONDS ────────────────────────────────────────
  // Thirteen deletes, three of which cascade to child tables, so the work scales with the tenant
  // even though the statement count does not. On 31 Aug this took 17,599 ms against Prisma's 5,000
  // ms default and died with P2028 — "consider increasing the interactive transaction timeout or
  // doing less work in the transaction" — leaving a half-generated demo tenant unpurged. Twice.
  //
  // Following lib/demo/generate's DEMO_TX, which exists for the same stall on the same database,
  // and doubled: a purge is rarer and larger than one generation batch, and the cost of a budget
  // that is too generous is a slow failure, while the cost of one that is too small is an
  // undeleted tenant. `maxWait` is its own trap — it bounds ACQUIRING the connection, and the 2s
  // default fails under exactly the load that makes the timeout matter.
  //
  // NOT SPLIT. The identity sweep and the group delete must stay atomic — "a purge that half-erased
  // somebody would be worse than one that failed, because only the failure is visible" — and
  // splitting the bulk deletes above them trades a clean failure for a resumable partial one. That
  // trade should be forced by a measurement near this ceiling, not anticipated.
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.invoice.deleteMany({ where: { group_id: groupId } });      // → InvoiceLine cascades
    await tx.booking.deleteMany({ where: { group_id: groupId } });
    await tx.jobCard.deleteMany({ where: { group_id: groupId } });      // → JobCardPhoto/Item cascade
    await tx.user.deleteMany({ where: { group_id: groupId } });         // EXPLICIT (SetNull would orphan PII) → Account/Session/UserSite cascade
    await tx.uploadTelemetry.deleteMany({ where: { group_id: groupId } }); // no FK — cascade misses
    await tx.vinReadShadow.deleteMany({ where: { group_id: groupId } });   // no FK — cascade misses

    // ── SUBJECT-KEYED SWEEP. No FK to Group, so the cascade below never sees these. ────────────
    // In the SAME transaction as the rest: a purge that half-erased somebody would be worse than
    // one that failed, because only the failure is visible.
    if (subjects.userIds.length) {
      await tx.twoFactorSecret.deleteMany({ where: { subject_type: 'tenant', subject_id: { in: subjects.userIds } } });
      await tx.deliveredCode.deleteMany({ where: { subject_type: 'tenant', subject_id: { in: subjects.userIds } } });
      await tx.twoFactorRecoveryCode.deleteMany({ where: { subject_type: 'tenant', subject_id: { in: subjects.userIds } } });
    }
    // The identifier IS the email address, so these rows are PII whether or not they have expired.
    if (subjects.emails.length) {
      await tx.verificationToken.deleteMany({ where: { identifier: { in: subjects.emails } } });
    }
    // SetNull would leave the email behind with a nulled group — the same trap the User delete above
    // avoids. Deleted explicitly, before the cascade gets the chance to merely disown it.
    await tx.countryWaitlist.deleteMany({ where: { group_id: groupId } });
    await tx.authRateLimit.deleteMany({ where: { key: { in: tenantRateLimitKeys(groupId, subjects.userIds) } } });
    // NOT swept: the per-IP and per-destination keys. The destination is hashed and the IP is not
    // this tenant's to claim — one address serves many people, and deleting it on their behalf
    // would blank a live limiter for whoever else is behind it. Bounded by the reaper instead
    // (lib/auth-rate-limit.reapRateLimits).

    await tx.group.delete({ where: { id: groupId } });                 // cascades the entire remainder
  }, PURGE_TX);

  const after = await countTenantRows(groupId, subjects); // SAME identifiers — see the header

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
