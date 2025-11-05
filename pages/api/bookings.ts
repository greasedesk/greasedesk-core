/**
 * File: pages/api/bookings.ts
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Returns today's bookings for the account.
 * Right now uses mock data in lib/db.ts.
 */
import type { NextApiRequest, NextApiResponse } from "next";
// FIX: Changed from named import ({}) to default import, as exported from lib/db
import getTodayBookingsMock from "../../lib/db"; 

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // later we'll read auth token -> derive account_id
  const accountId = "acct-1";

  const rows = await getTodayBookingsMock(accountId);
  res.status(200).json(rows);
}