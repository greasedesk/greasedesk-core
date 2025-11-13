/**
 * File: pages/api/bookings.ts
 * Last edited: 2025-11-13 21:26 Europe/London (FIXED - ENFORCED TENANT SCOPING)
 *
 * Returns today's bookings for the current site.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "../../lib/db"; 
// 💥 FIX: Import NextAuth helpers to get the user session
import { getServerSession } from 'next-auth';
import { authOptions } from './auth/[...nextauth]'; // Assuming authOptions is located here

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // 1. Get the current user session
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any; // Cast to 'any' to access custom fields

  // 2. Multi-tenancy check: Ensure user is authenticated and linked to a site
  if (!user?.site_id) {
    // Return empty array or unauthorized error if context is missing
    return res.status(401).json({ error: 'Unauthorized: Missing site context.' });
  }

  // 🛑 FIX: Use the actual Site ID from the authenticated user's session
  const siteId = user.site_id;
  
  // Define today's date range for filtering
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  try {
    // 3. Query the database, scoped by siteId (Multi-tenancy enforced)
    const rows = await prisma.booking.findMany({ 
      where: { 
        site_id: siteId, // Filter by the user's current site
        date: {
          gte: todayStart,
          lte: todayEnd,
        },
      },
      // You may want to select specific fields here to optimize performance
      select: { 
        id: true, 
        customer_name: true, 
        vehicle_reg: true, 
        date: true 
      }
    });
  
    // 4. Return the tenant-scoped data
    return res.status(200).json(rows);

  } catch (error) {
    console.error("Bookings API Error:", error);
    return res.status(500).json({ error: 'Failed to fetch bookings.' });
  }
}