/**
 * File: pages/api/intake-media.ts
 * A FRESH PRESIGNED URL for one piece of intake media, for a customer holding a report link.
 *
 *   GET ?token=…&id=…  → { url }
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * lib/r2 issues 15-minute URLs, and that short window is deliberate: it bounds a leaked URL. But a
 * 20MB walkaround on forecourt signal can outlive it MID-STREAM, and the failure looks like a video
 * that simply stops — no error, nothing to act on. So the page asks for a new URL when playback
 * fails rather than the window being widened for everyone.
 *
 * Scoped exactly like the report itself: the media must be an INTAKE item on the card the token
 * names. A valid token cannot fetch another card's video.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { resolveMagicLink } from '@/lib/magic-link';
import { clientIp } from '@/lib/auth-rate-limit';
import { presignGet } from '@/lib/r2';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const token = String(req.query.token ?? '');
  const id = String(req.query.id ?? '');
  if (!token || !id) return res.status(400).json({ message: 'A token and an id are required.' });

  const resolved = await resolveMagicLink(token, { purpose: 'intake_report', ip: clientIp(req.headers as any), recordUse: false });
  if (!resolved.ok) return res.status(404).json({ message: 'This report link is no longer valid.' });

  const media = await prisma.jobCardPhoto.findFirst({
    where: { id, job_card_id: resolved.link.jobCardId, group_id: resolved.link.groupId, stage: 'intake' },
    select: { r2_key: true },
  });
  if (!media?.r2_key) return res.status(404).json({ message: 'That media is no longer available.' });

  const url = await presignGet(media.r2_key);
  if (!url) return res.status(503).json({ message: 'Media storage is unavailable.' });
  // no-store: the URL expires, and a cached response would hand back a dead one.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ url });
}
