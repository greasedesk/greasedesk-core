/**
 * File: pages/api/vehicle-lookup.ts
 * Look up a vehicle + its CURRENT owner by registration, tenant-scoped, for form pre-fill (the diary
 * quick-create fills known cars so they aren't re-typed). GET ?reg=XXX. Read-only; car-first — the
 * owner is resolved via the VehicleOwnership edge (getCurrentOwnerId), never Vehicle.customer_id.
 * Returns { found:false } for an unknown reg (a new car). Authority = canAccessSite for any of the
 * caller's sites (they can create cards here; reading a reg they can book is the same tier).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { getCurrentOwnerId, normalizeReg } from '@/lib/vehicle-identity';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const reg = normalizeReg(req.query.reg as string);
  if (!reg) return res.status(400).json({ message: 'Missing reg.' });

  // Tenant-scoped find-by-CANONICAL-reg (same key the create path matches). Latest wins if a reg dupes.
  const vehicle = (await prisma.vehicle.findFirst({
    where: { group_id: user.group_id, registration_normalized: reg },
    orderBy: { created_at: 'desc' },
    select: { id: true, registration: true, vin: true, mileage_at_create: true, make: true, model: true, colour: true, fuel_type: true, year: true, engine_cc: true },
  })) as any;
  if (!vehicle) return res.status(200).json({ found: false });

  // Current owner via the ownership edge.
  const ownerId = await getCurrentOwnerId(prisma as any, vehicle.id);
  const owner = ownerId
    ? ((await prisma.customer.findUnique({ where: { id: ownerId }, select: { name: true, phone: true, email: true } })) as { name: string; phone: string | null; email: string | null } | null)
    : null;

  return res.status(200).json({
    found: true,
    vehicle: {
      registration: vehicle.registration, vin: vehicle.vin ?? '', mileage: vehicle.mileage_at_create ?? null,
      make: vehicle.make ?? '', model: vehicle.model ?? '', colour: vehicle.colour ?? '',
      fuel: vehicle.fuel_type ?? '', year: vehicle.year ?? null, engineCc: vehicle.engine_cc ?? null,
    },
    owner: { name: owner?.name ?? '', phone: owner?.phone ?? '', email: owner?.email ?? '' },
  });
}
