/**
 * File: pages/api/pwa/upload-error.ts
 * Upload-failure telemetry from the outbox drain (ruling 2026-07-13: a video failure must never
 * be swallowed into a bare string on one handset). The drain beacons { step, status, code, body }
 * and it lands in the UploadTelemetry table — the TECHNICAL black-box, deliberately NOT the audit
 * trail (ruling 2026-07-14: the audit trail is the card's BUSINESS record; stack traces have no
 * place in the ledger). Best-effort by design: the drain never waits on or retries this call.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, photoId, kind, attempts, detail } = (req.body || {}) as any;
  if (!jobCardId || !detail || typeof detail !== 'object') return res.status(400).json({ message: 'jobCardId and detail are required.' });
  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'No access.' });

  await prisma.uploadTelemetry.create({
    data: {
      group_id: user.group_id as string,
      job_card_id: jobCardId,
      photo_id: String(photoId || '').slice(0, 64),
      kind: String(kind || '').slice(0, 16),
      attempts: Number(attempts) || 0,
      step: String(detail.step || '').slice(0, 64),
      status: Number(detail.status) || 0,
      code: detail.code ? String(detail.code).slice(0, 32) : null,
      body: String(detail.body || '').slice(0, 300),
    },
  });
  return res.status(200).json({ ok: true });
}
