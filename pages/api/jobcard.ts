/**
 * File: pages/api/jobcard.ts
 * Last edited: 2025-10-27 21:25 Europe/London
 *
 * Returns job card detail (intake photos, checklist, etc).
 * Stub for now.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { getJobCardMock } from "../../lib/db";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const jobCardId =
    (req.query.id as string | undefined) ||
    (req.body && (req.body.id as string | undefined));

  if (!jobCardId) {
    res.status(400).json({ ok: false, error: "Missing job card id" });
    return;
  }

  const card = await getJobCardMock(jobCardId);
  res.status(200).json(card);
}
