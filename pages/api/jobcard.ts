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

  if (req.method === 'GET') {
    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ message: 'Missing job card id' });

    // Tenant scope: only return the card if it belongs to the caller's group.
    const card = await prisma.jobCard.findFirst({
      where: { id, group_id: groupId },
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
          where: { id: siteId },
          select: { group_id: true },
        });
        if (!site || site.group_id !== groupId) {
          throw new Error('FORBIDDEN_SITE');
        }

        // JobCard requires a profit centre; use the site's first one (seeded "Workshop").
        const profitCentre = await tx.profitCentre.findFirst({
          where: { site_id: siteId },
          select: { id: true },
        });
        if (!profitCentre) throw new Error('NO_PROFIT_CENTRE');

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
              site_id: siteId,
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
              mileage_at_create: mileage,
            },
            select: { id: true },
          });
          vehicleId = createdVehicle.id;
        }

        return tx.jobCard.create({
          data: {
            group_id: groupId,
            site_id: siteId,
            profit_centre_id: profitCentre.id,
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
      });

      return res.status(201).json({ id: card.id, message: 'Job card created.' });
    } catch (error: any) {
      if (error?.message === 'FORBIDDEN_SITE') {
        return res.status(403).json({ message: 'You do not have permission to use this site.' });
      }
      if (error?.message === 'NO_PROFIT_CENTRE') {
        return res
          .status(400)
          .json({ message: 'No profit centre is configured for this site. Add one before creating job cards.' });
      }
      console.error('Job Card Create Error:', error);
      return res.status(500).json({ message: 'Failed to create job card. Check logs for details.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
