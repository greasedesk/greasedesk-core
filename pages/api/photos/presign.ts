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

// Server-side content-type ALLOWLIST — never trust the client's declared type blindly. Maps each
// permitted type to its key extension + media kind. video/quicktime included because iOS native
// capture emits .mov; rejecting it would refuse every iPhone upload.
const ALLOWED: Record<string, { ext: string; media: 'photo' | 'video' }> = {
  'image/jpeg': { ext: 'jpg', media: 'photo' },
  'image/png': { ext: 'png', media: 'photo' },
  'video/mp4': { ext: 'mp4', media: 'video' },
  'video/webm': { ext: 'webm', media: 'video' },
  'video/quicktime': { ext: 'mov', media: 'video' },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  if (!r2Configured()) return res.status(503).json({ message: 'Photo storage isn’t set up yet.' });

  const { jobCardId, stage, slot, contentType, photoId: clientPhotoId } = (req.body || {}) as { jobCardId?: string; stage?: string; slot?: string; contentType?: string; photoId?: string };
  if (!jobCardId || !stage || !slot || !STAGES.includes(stage)) return res.status(400).json({ message: 'jobCardId, stage and slot are required.' });
  const allowed = ALLOWED[String(contentType || 'image/jpeg').toLowerCase()];
  if (!allowed) return res.status(400).json({ message: 'That file type isn’t supported — use a photo (JPEG/PNG) or a video (MP4/WebM/MOV).' });
  // IDEMPOTENCY HINGE (the outbox turns on this): the client may generate photoId AT CAPTURE, so
  // a replayed queue entry re-presigns to the SAME R2 key and the commit upserts the same row.
  // Strictly a UUID — anything else is rejected, never trusted into the key.
  if (clientPhotoId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(clientPhotoId))) {
    return res.status(400).json({ message: 'photoId must be a UUID.' });
  }

  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const photoId = clientPhotoId ? String(clientPhotoId).toLowerCase() : randomUUID(); // capture-time client id, or server-minted (desktop path unchanged)
  const key = photoKey(user.group_id as string, jobCardId, stage, slot, photoId, allowed.ext);
  const uploadUrl = await presignPut(key, String(contentType || 'image/jpeg').toLowerCase());
  if (!uploadUrl) return res.status(502).json({ message: 'Could not prepare the upload.' });

  // mediaType comes back to the client so the commit can't claim a video was a photo (or vice versa) —
  // the commit route re-derives it from the key extension anyway (server-authoritative).
  return res.status(200).json({ photoId, key, uploadUrl, mediaType: allowed.media });
}
