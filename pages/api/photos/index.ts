/**
 * File: pages/api/photos/index.ts
 *   GET  ?jobCardId=&stage=  → the stage's photos with a presigned GET url each (for display)
 *   POST { jobCardId, stage, slot, label?, photoId, key } → commit a row AFTER a successful R2 upload
 * Operational authority (canAccessSite). Photos are tenant-scoped via the card's group.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { presignGet } from '@/lib/r2';

const STAGES = ['intake', 'injob', 'completion'];

async function authCard(req: NextApiRequest, res: NextApiResponse, jobCardId: string) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) { res.status(401).json({ message: 'Not authenticated.' }); return null; }
  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true } });
  if (!card) { res.status(404).json({ message: 'Job card not found.' }); return null; }
  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) { res.status(403).json({ message: 'You do not have access to this job card’s location.' }); return null; }
  return { user, card };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const jobCardId = String(req.query.jobCardId || '');
    const stage = req.query.stage ? String(req.query.stage) : undefined;
    if (!jobCardId) return res.status(400).json({ message: 'Missing jobCardId.' });
    const ctx = await authCard(req, res, jobCardId); if (!ctx) return;
    const rows = await prisma.jobCardPhoto.findMany({
      where: { job_card_id: jobCardId, ...(stage ? { stage } : {}) },
      orderBy: { uploaded_at: 'asc' },
      select: { id: true, stage: true, slot: true, label: true, media_type: true, duration_seconds: true, r2_key: true, uploaded_at: true, user: { select: { name: true } } },
    });
    const photos = await Promise.all(rows.map(async (r: any) => ({
      id: r.id, stage: r.stage, slot: r.slot, label: r.label,
      mediaType: r.media_type === 'video' ? 'video' : 'photo', // NULL (pre-video rows) = photo
      durationSeconds: r.duration_seconds ?? null,
      url: r.r2_key ? await presignGet(r.r2_key) : null,
      uploadedAt: r.uploaded_at, uploadedBy: r.user?.name ?? null,
    })));
    return res.status(200).json({ photos });
  }

  if (req.method === 'POST') {
    const { jobCardId, stage, slot, label, photoId, key, durationSeconds } = (req.body || {}) as any;
    if (!jobCardId || !stage || !slot || !photoId || !key || !STAGES.includes(stage)) return res.status(400).json({ message: 'Missing photo fields.' });
    const ctx = await authCard(req, res, jobCardId); if (!ctx) return;
    // key must belong to this tenant + card (defence against a forged commit).
    if (!String(key).startsWith(`${ctx.user.group_id}/${jobCardId}/`)) return res.status(400).json({ message: 'Invalid key.' });
    // media_type derived from the key EXTENSION (the presign route allowlisted it) — server-authoritative,
    // not the client's word. Duration is display-only metadata; sanity-clamped.
    const ext = String(key).split('.').pop()?.toLowerCase();
    const media = ['mp4', 'webm', 'mov'].includes(ext || '') ? 'video' : 'photo';
    const dur = Number(durationSeconds);
    const duration = media === 'video' && Number.isFinite(dur) && dur > 0 && dur < 86400 ? Math.round(dur) : null;
    const row = await prisma.jobCardPhoto.create({
      data: { id: photoId, job_card_id: jobCardId, group_id: ctx.user.group_id, stage, slot, label: label ? String(label).slice(0, 200) : null, media_type: media, duration_seconds: duration, r2_key: key, uploaded_by: ctx.user.id },
      select: { id: true },
    });
    return res.status(201).json({ id: row.id });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
