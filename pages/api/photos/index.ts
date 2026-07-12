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
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { presignGet } from '@/lib/r2';
import { writeAudit } from '@/lib/audit';

const STAGES = ['intake', 'injob', 'completion'];

async function authCard(req: NextApiRequest, res: NextApiResponse, jobCardId: string) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) { res.status(401).json({ message: 'Not authenticated.' }); return null; }
  const card = await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: user.group_id }, select: { id: true, site_id: true, status: true } });
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
    // SOFT AUTO-ADVANCE (ruling 2026-07-07): an in-job/completion photo on an accepted card IS
    // evidence work began — fire accepted→in_progress in the same tx, audited with auto:true
    // (inferred start; a Start-work press audits without it — different clocking grains).
    // IDEMPOTENT COMMIT (the outbox turns on this): a replayed queue entry re-commits the SAME
    // photoId — 200 whether it's the first attempt or the fifth; a double-replay overwrites
    // itself and nothing else. A photoId that exists on a DIFFERENT card is a forgery, not a replay.
    const existing = await prisma.jobCardPhoto.findUnique({ where: { id: photoId }, select: { id: true, job_card_id: true } });
    if (existing && existing.job_card_id !== jobCardId) return res.status(400).json({ message: 'Invalid photo id.' });
    if (existing) return res.status(200).json({ id: existing.id, replay: true }); // the first commit's row IS the receipt

    const autoStart = ctx.card.status === 'accepted' && (stage === 'injob' || stage === 'completion');
    const row = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (autoStart) {
        await tx.jobCard.update({ where: { id: jobCardId }, data: { status: 'in_progress' } });
        await writeAudit(tx, {
          groupId: ctx.user.group_id as string, userId: ctx.user.id as string, jobCardId,
          action: 'status.in_progress', diff: { from: 'accepted', to: 'in_progress', auto: true, trigger: `photo.${stage}` },
        });
      }
      // upsert (not create): two racing replays of the same id land ONE row either way.
      return tx.jobCardPhoto.upsert({
        where: { id: photoId },
        create: { id: photoId, job_card_id: jobCardId, group_id: ctx.user.group_id, stage, slot, label: label ? String(label).slice(0, 200) : null, media_type: media, duration_seconds: duration, r2_key: key, uploaded_by: ctx.user.id },
        update: {}, // replay: the original row stands untouched
        select: { id: true },
      });
    });
    return res.status(200).json({ id: row.id, ...(autoStart ? { status: 'in_progress' } : {}) });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
