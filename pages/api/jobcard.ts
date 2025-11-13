/**
 * File: pages/api/jobcard.ts
 * Last edited: 2025-11-13 12:22 Europe/London (FIXED)
 *
 * Returns job card detail (intake photos, checklist, etc).
 * Stub for now.
 */
import type { NextApiRequest, NextApiResponse } from "next";
// 💥 FIX: Removed the erroneous import for getJobCardMock,
// and imported the actual prisma client needed for future work.
import { prisma } from "../../lib/db"; 

// NOTE: Since getJobCardMock is no longer imported, you will need to implement 
// the actual database query or correctly import the mock function from its 
// intended (non-existent) location.

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
  
  // ⚠️ TEMPORARY FIX: Commenting out the line that calls the missing mock function.
  // This fixes the build error. You must replace this with a real Prisma query soon.
  // const card = await getJobCardMock(jobCardId);
  
  // Example of what the real code might look like:
  const card = await prisma.jobCard.findUnique({
    where: { id: jobCardId },
    include: { intakePhotos: true, checklist: true },
  });

  // NOTE: If 'card' is null, we should handle that gracefully.
  if (!card) {
    return res.status(404).json({ ok: false, error: "Job card not found" });
  }

  res.status(200).json(card);
}