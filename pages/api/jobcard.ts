/**
 * File: pages/api/jobcard.ts
 * Slice 1 (job-card spine).
 *
 * GET  ?id=<uuid>  → fetch one job card, scoped to the caller's group_id,
 *                    using the REAL schema (relations: customer, vehicle, photos, items).
 * POST             → create a job card for the caller's group_id/site_id.
 *                    Find-or-creates the Customer + Vehicle (by registration within the
 *                    tenant) and attaches the site's profit centre, all in one transaction.
 *
 * Auth/ownership pattern mirrors pages/api/settings/update.ts: getServerSession, then
 * scope every read and write to the session's group_id/site_id.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireCanWrite } from '@/lib/admin-guard';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canCreateDiaryEntry } from '@/lib/permissions';
import { placeJobCard } from '@/lib/diary-booking';
import { ensureIdentityAndCurrentOwner, getCurrentOwnerId, normalizeVin, normalizeReg } from '@/lib/vehicle-identity';

type CreateJobCardBody = {
  registration: string;
  customerName: string;
  phone?: string;
  email?: string;
  vin?: string;
  mileage?: number | string;
  // Vehicle data (make/model/colour/year/fuel/engineCc auto-fill from DVSA MOT / DVLA VES).
  make?: string; model?: string; colour?: string; year?: number | string; fuel?: string; engineCc?: number | string;
  // DVSA MOT metadata (for the banked reminder feature): ISO dates + miles.
  motExpiry?: string; lastMotMileage?: number | string; lastMotDate?: string;
  flag_urgent?: boolean;
  flag_sales_car?: boolean;
  flag_customer_car?: boolean;
  flag_mot?: boolean;
  flag_diag?: boolean;
  // Optional: create the card already SCHEDULED (from the diary). Requires canManageSite; the
  // booking runs through the shared guard (double-booking refused).
  siteId?: string;
  resourceId?: string;
  startAt?: string;
  endAt?: string;
};

// Coerce an optional numeric field (year / engine cc) to a clean non-negative integer, else null.
const intOrNull = (v: unknown): number | null => {
  if (v === undefined || v === null || `${v}`.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};
// Coerce an optional ISO/parseable date (MOT expiry) to a Date, else null. Never throws on bad input.
const dateOrNull = (v: unknown): Date | null => {
  if (v === undefined || v === null || `${v}`.trim() === '') return null;
  const t = Date.parse(`${v}`);
  return Number.isFinite(t) ? new Date(t) : null;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id || !user?.site_id) {
    return res.status(401).json({
      message: 'Authentication Error: Group/Site context not found. Please sign in again.',
    });
  }

  const groupId = user.group_id as string;
  const siteId = user.site_id as string;
  const vis = await getVisibility(user.id as string); // visible sites

  if (req.method === 'GET') {
    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ message: 'Missing job card id' });

    // Visibility scope: only return the card if it sits on a site the caller may see.
    const card = await prisma.jobCard.findFirst({
      where: { id, site_id: { in: vis.siteIds } },
      include: { customer: true, vehicle: true, photos: true, items: true },
    });

    if (!card) return res.status(404).json({ message: 'Job card not found' });
    return res.status(200).json(card);
  }

  if (req.method === 'POST') {
    if (!(await requireCanWrite(groupId, res))) return; // lapsed = read-only; a new job card is new work
    const body = (req.body || {}) as CreateJobCardBody;

    // Canonical registration (uppercase, non-alphanumeric stripped) — both the stored/display value and
    // the match key, so "BK69 YAV" and "BK69YAV" are ONE vehicle.
    const registration = normalizeReg(body.registration) || '';
    const customerName = (body.customerName || '').trim();

    if (!registration) return res.status(400).json({ message: 'Registration is required.' });
    if (!customerName) return res.status(400).json({ message: 'Customer name is required.' });

    // Target site: an explicit siteId (e.g. from the diary) the caller can access, else the session site.
    const targetSiteId = body.siteId && vis.siteIds.includes(body.siteId) ? body.siteId : siteId;
    if (!vis.siteIds.includes(targetSiteId)) {
      return res.status(403).json({ message: 'You are not assigned to this location.' });
    }

    // Optional scheduling (create + place). Resource allocation → manager/admin only.
    const scheduling = !!(body.resourceId && body.startAt && body.endAt);
    let start: Date | null = null, end: Date | null = null;
    if (scheduling) {
      const perms = await getTenantPermissions(groupId);
      if (!canCreateDiaryEntry(vis, targetSiteId, perms)) return res.status(403).json({ message: 'You do not have permission to create a scheduled job.' });
      start = new Date(body.startAt as string); end = new Date(body.endAt as string);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
        return res.status(400).json({ message: 'Invalid start/end time.' });
      }
    }

    let mileage: number | null = null;
    if (body.mileage !== undefined && body.mileage !== null && `${body.mileage}`.trim() !== '') {
      const m = Number(body.mileage);
      if (!Number.isFinite(m) || m < 0 || !Number.isInteger(m)) return res.status(400).json({ message: 'Mileage must be a whole number.' });
      if (m > 999999) return res.status(400).json({ message: 'Mileage must be under 1,000,000.' }); // 7+ digits overflow the column
      mileage = Math.trunc(m);
    }

    try {
      const card = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Ownership: confirm the site belongs to this group.
        const site = await tx.site.findUnique({
          where: { id: targetSiteId },
          select: { group_id: true },
        });
        if (!site || site.group_id !== groupId) {
          throw new Error('FORBIDDEN_SITE');
        }

        // Find-or-create Vehicle by registration within the tenant. Owner is resolved from the
        // ownership EDGE (Stage B) — customer_id is never read here.
        const vehicle = await tx.vehicle.findFirst({
          where: { group_id: groupId, registration_normalized: registration }, // canonical match (no-space)
          select: { id: true },
        });

        const newCustomer = () =>
          tx.customer.create({
            data: {
              group_id: groupId,
              site_id: targetSiteId,
              name: customerName,
              phone: body.phone?.trim() || null,
              email: body.email?.trim() || null,
            },
            select: { id: true },
          });

        let customerId: string;
        let vehicleId: string;

        if (vehicle) {
          vehicleId = vehicle.id;
          // Stage B: resolve the current owner from the edge, NOT vehicle.customer_id.
          const ownerId = await getCurrentOwnerId(tx, vehicleId);
          // Defensive: a found vehicle with no current edge (pre-backfill anomaly) is healed by
          // creating an owner here; ensureIdentityAndCurrentOwner below opens the edge for it.
          customerId = ownerId ?? (await newCustomer()).id;
        } else {
          customerId = (await newCustomer()).id;
          const createdVehicle = await tx.vehicle.create({
            data: {
              group_id: groupId,
              // Stage C: Vehicle.customer_id is retired — no longer written. The owner lives on the
              // VehicleOwnership edge (created just below). The column stays nullable + vestigial.
              registration,
              registration_normalized: registration, // registration is already canonical
              vin: body.vin?.trim() || null,
              vin_normalized: normalizeVin(body.vin),
              make: body.make?.trim() || null,
              model: body.model?.trim() || null,
              colour: body.colour?.trim() || null,
              fuel_type: body.fuel?.trim() || null,
              year: intOrNull(body.year),
              engine_cc: intOrNull(body.engineCc),
              mot_expiry: dateOrNull(body.motExpiry),
              last_mot_mileage: intOrNull(body.lastMotMileage),
              last_mot_date: dateOrNull(body.lastMotDate),
              mileage_at_create: mileage,
            },
            select: { id: true },
          });
          vehicleId = createdVehicle.id;
        }

        // Dual-write (unchanged): ensure the identity + current ownership edge exist (idempotent).
        // JobCard.customer_id below is satisfied by the edge-resolved customerId, not the weld.
        await ensureIdentityAndCurrentOwner(tx, {
          vehicleId, groupId, customerId, registration, vin: body.vin,
        });

        const created = await tx.jobCard.create({
          data: {
            group_id: groupId,
            site_id: targetSiteId,
            customer_id: customerId,
            vehicle_id: vehicleId,
            odometer_in: mileage,
            flag_urgent: !!body.flag_urgent,
            flag_sales_car: !!body.flag_sales_car,
            flag_customer_car: !!body.flag_customer_car,
            flag_mot: !!body.flag_mot,
            flag_diag: !!body.flag_diag,
          },
          select: { id: true },
        });
        // Create + schedule atomically through the shared booking guard (double-booking refused).
        // Diary drag-create is within-day, so working-minutes = (end - start).
        if (scheduling) {
          const workingMinutes = Math.round(((end as Date).getTime() - (start as Date).getTime()) / 60000);
          await placeJobCard(tx, { jobCardId: created.id, resourceId: body.resourceId as string, start: start as Date, workingMinutes, siteIds: vis.siteIds });
        }
        return created;
      });

      return res.status(201).json({ id: card.id, message: scheduling ? 'Job card created and scheduled.' : 'Job card created.' });
    } catch (error: any) {
      const m = error?.message || '';
      if (m === 'FORBIDDEN_SITE') return res.status(403).json({ message: 'You do not have permission to use this site.' });
      if (m === 'RESOURCE_NOT_FOUND') return res.status(404).json({ message: 'Resource not found.' });
      if (m === 'CROSS_SITE') return res.status(400).json({ message: 'A job card can only be placed on a resource at its own location.' });
      if (m.startsWith('CLASH:')) return res.status(409).json({ message: `Time overlaps ${m.slice(6)} on this resource. Double-booking refused.`, clash: true });
      console.error('Job Card Create Error:', error); // real detail stays in the server log, never the user
      return res.status(500).json({ message: 'Something went wrong — please try again.' });
    }
  }

  // Hard-delete (admin only) — distinct from cancel (which keeps a read-only record). Removes the card
  // and everything that hangs off it. Children are deleted EXPLICITLY inside the tx (not relying on FK
  // cascade) so the destruction is auditable in one place: estimate lines, photos, and the polymorphic
  // audit trail (no FK). The booking lives on the card row itself, so deleting the card frees the diary
  // slot. The VEHICLE + ownership edge are NOT touched (car-first: the car outlives any one job).
  // REFUSED if ANY Invoice row exists — protects the sequential VAT numbering chain (real invoiced
  // cards must be cancelled, not deleted).
  if (req.method === 'DELETE') {
    if (!vis.isAdmin) return res.status(403).json({ message: 'Admin access required to delete a job card.' });
    const id = (req.query.id as string) || (req.body && (req.body.id as string)) || '';
    if (!id) return res.status(400).json({ message: 'Missing job card id.' });

    // Group-scoped (admin sees every group site). ANY invoice row blocks (issued|paid — no drafts exist).
    const card = await prisma.jobCard.findFirst({
      where: { id, site_id: { in: vis.siteIds } },
      select: { id: true, invoice: { select: { id: true } } },
    });
    if (!card) return res.status(404).json({ message: 'Job card not found.' });
    if (card.invoice) return res.status(409).json({ message: 'This card has an invoice and can’t be deleted. Cancel it instead.' });

    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.jobCardItem.deleteMany({ where: { job_card_id: id } });   // estimate lines — explicit
        await tx.jobCardPhoto.deleteMany({ where: { job_card_id: id } });  // intake/completion photos — explicit
        await tx.auditLog.deleteMany({ where: { group_id: groupId, entity: 'job_card', entity_id: id } });
        await tx.jobCard.delete({ where: { id } }); // booking fields live on the row → diary slot freed
      });
    } catch (error) {
      console.error('Job Card Delete Error:', error);
      return res.status(500).json({ message: 'Failed to delete job card.' });
    }
    return res.status(200).json({ message: 'Job card deleted.' });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
