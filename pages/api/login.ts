/**
 * File: pages/api/login.ts
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Placeholder login.
 * Always returns 200 so you can click through.
 */
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  // we will verify against users table later
  const { email } = req.body || {};
  if (!email) {
    res.status(400).json({ ok: false, error: "Missing email" });
    return;
  }

  // TODO: issue session/JWT + set cookie
  res.status(200).json({
    ok: true,
    account_id: "acct-1",
    role: "admin",
    email
  });
}
