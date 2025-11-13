/**
 * File: pages/api/bookings.ts
 * Last edited: 2025-11-13 12:20 Europe/London (FIXED)
 *
 * Returns today's bookings for the account.
 * Right now uses mock data in lib/db.ts.
 */
import type { NextApiRequest, NextApiResponse } from "next";
// 💥 FIX: Removed the erroneous import for getTodayBookingsMock,
// and imported the actual prisma client needed for future work.
import { prisma } from "../../lib/db"; 

// NOTE: Since getTodayBookingsMock is no longer imported, you'll need
// to implement the actual database query or correctly import the mock
// function from its intended (non-existent) location.

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // later we'll read auth token -> derive account_id
  const accountId = "acct-1";

  // ⚠️ TEMPORARY FIX: Commenting out the line that calls the missing mock function.
  // This will fix the build error but cause the API to return nothing (rows = undefined).
  // You must replace this with a real Prisma query soon.
  // const rows = await getTodayBookingsMock(accountId); 
  
  // Example of what the real code might look like:
  const rows = await prisma.booking.findMany({ 
    where: { account_id: accountId, date: new Date() },
  });

  res.status(200).json(rows);
}