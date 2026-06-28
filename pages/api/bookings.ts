/**
 * File: pages/api/bookings.ts
 * Slice 1: fixed against the REAL schema.
 *
 * Returns today's bookings for the caller's site, tenant-scoped by group_id + site_id.
 * The Booking model has no `date` / `customer_name` / `vehicle_reg` columns — it uses
 * `booking_date` and relations to Customer / Vehicle / ServiceCatalogue. We map those to
 * the flat shape the /bookings page renders ({ id, time, reg, vehicle, service, status }).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;

  if (!user?.group_id || !user?.site_id) {
    return res.status(401).json({ error: 'Unauthorized: Missing group/site context.' });
  }

  const groupId = user.group_id as string;
  const siteId = user.site_id as string;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  try {
    type BookingDbRow = {
      id: string;
      status: string;
      booking_date: Date;
      start_time: Date | null;
      customer: { name: string } | null;
      vehicle: { registration: string | null; make: string | null; model: string | null } | null;
      service: { name: string } | null;
    };

    const rows = (await prisma.booking.findMany({
      where: {
        group_id: groupId, // tenant scope
        site_id: siteId,
        booking_date: { gte: todayStart, lte: todayEnd },
      },
      orderBy: [{ start_time: 'asc' }, { booking_date: 'asc' }],
      include: {
        customer: { select: { name: true } },
        vehicle: { select: { registration: true, make: true, model: true } },
        service: { select: { name: true } },
      },
    })) as BookingDbRow[];

    const fmtTime = (d: Date | null) =>
      d
        ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : '';

    const shaped = rows.map((b) => ({
      id: b.id,
      time: fmtTime(b.start_time ?? b.booking_date),
      reg: b.vehicle?.registration ?? '',
      vehicle: [b.vehicle?.make, b.vehicle?.model].filter(Boolean).join(' ') || '—',
      service: b.service?.name ?? '—',
      status: b.status,
    }));

    return res.status(200).json(shaped);
  } catch (error) {
    console.error('Bookings API Error:', error);
    return res.status(500).json({ error: 'Failed to fetch bookings.' });
  }
}
