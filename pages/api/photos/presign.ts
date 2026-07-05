/**
 * File: pages/api/photos/presign.ts
 * POST { jobCardId, stage, slot, contentType? } → a presigned R2 PUT URL for a direct browser upload.
 * Does NOT create a DB row (avoids orphans if the upload fails) — the client commits via POST /api/photos
 * after the upload succeeds. Operational authority (canAccessSite). Tenant-partitioned key.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { photoKey, presignPut, r2Configured } from '@/lib/r2';

const STAGES = ['intake', 'injob', 'completion'];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  if (!r2Configured()) return res.status(503).json({ message: 'Photo storage isn’t set up yet.' });

  const { jobCardId, stage, slot, contentType } = (req.body || {}) as { jobCardId?: string; stage?: string; slot?: string; contentType?: string };
  if (!jobCardId || !stage || !slot || !STAGES.includes(stage)) return res.status(400).json({ message: 'jobCardId, stage and slot are required.' });

  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const photoId = randomUUID();
  const key = photoKey(user.group_id as string, jobCardId, stage, slot, photoId);
  const uploadUrl = await presignPut(key, contentType || 'image/jpeg');
  if (!uploadUrl) return res.status(502).json({ message: 'Could not prepare the upload.' });

  return res.status(200).json({ photoId, key, uploadUrl });
}
