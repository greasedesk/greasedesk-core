/**
 * File: pages/api/quote-preview-seen.ts
 *
 * RECORDS THAT THE CUSTOMER VIEW WAS ACTUALLY RENDERED for this exact draft. Posted by the preview
 * step itself, not by a button that merely says "I looked" — the fingerprint is computed from the
 * STORED draft here, so what is recorded is the document that exists, not a claim about it.
 *
 * Editing anything afterwards changes the fingerprint and the send refuses again. That is the
 * whole mechanism: there is no invalidation path to forget, because staleness is divergence.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireTenantApi } from '@/lib/admin-guard';
import { draftFingerprint } from '@/lib/quote-preview';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;
  const jobCardId = String((req.body || {}).jobCardId || '');
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });

  // TENANT SCOPE ON THE WAY IN, never assumed from the id in the body.
  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: scope.groupId }, select: { id: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const hash = await draftFingerprint(jobCardId);
  await prisma.$transaction(async (tx) => {
    await tx.jobCard.update({
      where: { id: jobCardId },
      data: { quote_preview_hash: hash, quote_preview_at: new Date(), quote_preview_by: scope.userId },
    });
    await writeAudit(tx, {
      groupId: scope.groupId, userId: scope.userId, jobCardId,
      action: 'quote.preview_seen', diff: { fingerprint: hash.slice(0, 12) },
    });
  });
  return res.status(200).json({ ok: true });
}
