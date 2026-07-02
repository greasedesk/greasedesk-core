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
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canCreateDiaryEntry } from '@/lib/permissions';
import { placeJobCard } from '@/lib/diary-booking';
import { ensureIdentityAndCurrentOwner, normalizeVin } from '@/lib/vehicle-identity';

type CreateJobCardBody = {
  registration: string;
  customerName: string;
  phone?: string;
  email?: string;
  vin?: string;
  mileage?: number | string;
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
    const body = (req.body || {}) as CreateJobCardBody;

    const registration = (body.registration || '').trim().toUpperCase();
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
      if (!Number.isFinite(m) || m < 0) return res.status(400).json({ message: 'Invalid mileage.' });
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

        // Find-or-create Vehicle by registration within the tenant; reuse its customer.
        let vehicle = await tx.vehicle.findFirst({
          where: { group_id: groupId, registration },
          select: { id: true, customer_id: true },
        });

        let customerId: string;
        let vehicleId: string;

        if (vehicle) {
          customerId = vehicle.customer_id;
          vehicleId = vehicle.id;
        } else {
          const customer = await tx.customer.create({
            data: {
              group_id: groupId,
              site_id: targetSiteId,
              name: customerName,
              phone: body.phone?.trim() || null,
              email: body.email?.trim() || null,
            },
            select: { id: true },
          });
          customerId = customer.id;

          const createdVehicle = await tx.vehicle.create({
            data: {
              group_id: groupId,
              customer_id: customerId,
              registration,
              vin: body.vin?.trim() || null,
              vin_normalized: normalizeVin(body.vin),
              mileage_at_create: mileage,
            },
            select: { id: true },
          });
          vehicleId = createdVehicle.id;
        }

        // Stage A dual-write: mirror the weld into the identity + ownership-edge layer (idempotent).
        // customer_id above stays the read source until Stage B; this only keeps the new layer in step.
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
        if (scheduling) {
          await placeJobCard(tx, { jobCardId: created.id, resourceId: body.resourceId as string, start: start as Date, end: end as Date, siteIds: vis.siteIds });
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
      console.error('Job Card Create Error:', error);
      return res.status(500).json({ message: 'Failed to create job card. Check logs for details.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
