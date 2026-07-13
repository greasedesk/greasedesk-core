/**
 * File: pages/api/photos/multipart.ts
 * The resumable VIDEO upload lane (walkaround intake video — Wi-Fi-hostile 4G is the design
 * case). One authed route, five actions; bytes still never touch this function — parts go
 * browser↔R2 on presigned URLs exactly like the single-PUT photo path.
 *
 *   create   { jobCardId, stage, slot, contentType, photoId }        → { uploadId, key, partSize, maxParts }
 *   parts    { …ids, uploadId, partNumbers: number[] }               → { key, urls: [{ partNumber, url }] }
 *   status   { …ids, uploadId }                                      → { key, parts: [{ partNumber, etag }] }  (410 = upload gone: restart)
 *   complete { …ids, uploadId, parts: [{ partNumber, etag }] }       → { key }   (client then commits via POST /api/photos as normal)
 *   abort    { …ids, uploadId }                                      → { ok }    (explicit discard; the 7-day lifecycle rule reaps the rest)
 *
 * The KEY is derived server-side from ids on EVERY action (same photoKey as presign) — the client
 * never supplies one. 'create' refuses (503, transient for the outbox) until the bucket CORS
 * exposes ETag: without it the browser cannot read part ETags and Complete can never be
 * assembled — better to refuse the first byte than strand every upload at 100%.
 * Videos only: photos stay on the single-PUT path (a 300 KB jpeg needs no resume machinery).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import {
  photoKey, r2Configured, corsExposesEtag, createMultipartUpload, presignUploadPart,
  listUploadedParts, completeMultipartUpload, abortMultipartUpload, PART_SIZE, MAX_PARTS,
} from '@/lib/r2';

const STAGES = ['intake', 'injob', 'completion'];
const VIDEO_TYPES: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  if (!r2Configured()) return res.status(503).json({ message: 'Media storage isn’t set up yet.' });

  const { action, jobCardId, stage, slot, contentType, photoId, uploadId, partNumbers, parts } = (req.body || {}) as any;
  const ext = VIDEO_TYPES[String(contentType || '').toLowerCase()];
  if (!jobCardId || !stage || !slot || !STAGES.includes(stage)) return res.status(400).json({ message: 'jobCardId, stage and slot are required.' });
  if (!ext) return res.status(400).json({ message: 'Multipart uploads are for videos (MP4/WebM/MOV) only.' });
  if (!UUID_RE.test(String(photoId || ''))) return res.status(400).json({ message: 'photoId must be a UUID.' });

  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You do not have access to this job card’s location.' });

  const key = photoKey(user.group_id as string, jobCardId, stage, slot, String(photoId).toLowerCase(), ext);

  if (action === 'create') {
    // CORS prerequisite enforced HERE, before the first byte moves (see file header).
    const etagOk = await corsExposesEtag();
    if (!etagOk) return res.status(503).json({ message: 'Video storage needs a configuration update (CORS must expose ETag) — the video will be retried automatically.' });
    const id = await createMultipartUpload(key, String(contentType).toLowerCase());
    if (!id) return res.status(502).json({ message: 'Could not start the upload.' });
    return res.status(200).json({ uploadId: id, key, partSize: PART_SIZE, maxParts: MAX_PARTS });
  }

  if (!uploadId || typeof uploadId !== 'string') return res.status(400).json({ message: 'uploadId is required.' });

  if (action === 'parts') {
    const nums: number[] = Array.isArray(partNumbers) ? partNumbers.map(Number) : [];
    if (!nums.length || nums.length > MAX_PARTS || nums.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_PARTS)) {
      return res.status(400).json({ message: `partNumbers must be 1–${MAX_PARTS}.` });
    }
    const urls = await Promise.all(nums.map(async (n) => ({ partNumber: n, url: await presignUploadPart(key, uploadId, n) })));
    if (urls.some((u) => !u.url)) return res.status(502).json({ message: 'Could not prepare the upload.' });
    return res.status(200).json({ key, urls });
  }

  if (action === 'status') {
    try {
      const uploaded = await listUploadedParts(key, uploadId);
      if (uploaded === null) return res.status(410).json({ message: 'That upload no longer exists — start again.' }); // aborted/expired → client restarts cleanly
      return res.status(200).json({ key, parts: uploaded });
    } catch { return res.status(502).json({ message: 'Could not check the upload.' }); }
  }

  if (action === 'complete') {
    const list: { partNumber: number; etag: string }[] = Array.isArray(parts)
      ? parts.map((p: any) => ({ partNumber: Number(p?.partNumber), etag: String(p?.etag || '') })) : [];
    if (!list.length || list.length > MAX_PARTS || list.some((p) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > MAX_PARTS || !p.etag)) {
      return res.status(400).json({ message: 'parts must each carry partNumber and etag.' });
    }
    const ok = await completeMultipartUpload(key, uploadId, list);
    if (!ok) return res.status(502).json({ message: 'Could not finish the upload.' });
    return res.status(200).json({ key }); // the client now commits via POST /api/photos — same idempotent receipt as every photo
  }

  if (action === 'abort') {
    await abortMultipartUpload(key, uploadId);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ message: 'Unknown action.' });
}
