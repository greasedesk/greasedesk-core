/**
 * File: pages/api/vehicle-lookup.ts
 * Look up a vehicle + its CURRENT owner by registration, tenant-scoped, for form pre-fill (the diary
 * quick-create fills known cars so they aren't re-typed). GET ?reg=XXX. Read-only; car-first — the
 * owner is resolved via the VehicleOwnership edge (getCurrentOwnerId), never Vehicle.customer_id.
 * Returns { found:false } for an unknown reg (a new car). Authority = canAccessSite for any of the
 * caller's sites (they can create cards here; reading a reg they can book is the same tier).
 */
import { openDueItemsForVehicle } from '@/lib/due-items';
import { OPEN_FOR_DUPLICATE, openCardSummary, type OpenCardRow } from '@/lib/duplicate-cards';
import { noShowHistory } from '@/lib/no-show';
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
  // THE NO-SHOW HISTORY RIDES WITH THE OWNER, because this lookup fires at the exact moment the
  // count matters: someone is about to give this customer a slot. Derived (lib/no-show), never a
  // stored counter.
  const noShows = await noShowHistory(prisma, ownerId);
  // OPEN DUE ITEMS ride with the lookup for the same reason the no-show count does: this fires at
  // the moment somebody is booking the car in, which is exactly when "it also needs discs" turns
  // a slot into a bigger job. Same chokepoint the card reads (lib/due-items).
  const dueItems = await openDueItemsForVehicle(prisma, user.group_id, vehicle.id);
  // OPEN CARDS RIDE ALONG for the third time and the same reason as the two above: this fires at
  // the moment somebody is about to give this car a slot, which is the only moment "it already has
  // one" is worth saying. LX13ZPO ran two open cards for four days because nothing asked here.
  // Which statuses count is lib/duplicate-cards, not a list written out at this call site.
  const openCards = (await prisma.jobCard.findMany({
    where: { group_id: user.group_id, vehicle_id: vehicle.id, status: { in: OPEN_FOR_DUPLICATE as never } },
    orderBy: { created_at: 'asc' },
    select: { id: true, created_at: true, status: true, start_at: true,
              resource: { select: { name: true } }, invoice: { select: { id: true } } },
  })) as unknown as OpenCardRow[];

  return res.status(200).json({
    found: true,
    vehicle: {
      registration: vehicle.registration, vin: vehicle.vin ?? '', mileage: vehicle.mileage_at_create ?? null,
      make: vehicle.make ?? '', model: vehicle.model ?? '', colour: vehicle.colour ?? '',
      fuel: vehicle.fuel_type ?? '', year: vehicle.year ?? null, engineCc: vehicle.engine_cc ?? null,
    },
    owner: { name: owner?.name ?? '', phone: owner?.phone ?? '', email: owner?.email ?? '' },
    noShows,
    dueItems,
    openCards: openCards.map(openCardSummary),
  });
}
