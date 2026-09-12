/**
 * File: pages/api/jobcard-clock.ts
 * A MANAGER'S CORRECTION to a clock session. POST { correctsId, startedAt, endedAt?, reason }.
 *
 * ── ADMIN ONLY, AND WHY IT IS NOT A GRANT ───────────────────────────────────────────────────────
 * requireAdminApi, the existing chokepoint — not a new per-user permission. A correction rewrites
 * what a job cost in time, and the population who may do that is the population who already sees
 * the money. If it ever needs to be a mechanic-level grant it should be one deliberately, the way
 * can_invoice was.
 *
 * ── THE ORIGINAL IS NEVER TOUCHED ───────────────────────────────────────────────────────────────
 * The correction is a NEW ROW pointing at the original, carrying who made it and a mandatory
 * non-blank reason. The original stays visible on the card beside it. This endpoint could not edit
 * the original even if it tried: JobClockSession_append_only refuses in the database, so the
 * guarantee does not rest on this file staying the only caller.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminApi, requireTenantApi } from '@/lib/admin-guard';
import { prisma } from '@/lib/db';
import { correctSession } from '@/lib/job-clock-store';

const when = (raw: unknown): Date | null | 'bad' => {
  if (raw == null || raw === '') return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? 'bad' : d;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  // BOTH, and each for its own reason: requireAdminApi decides WHO MAY (403 for a non-admin), and
  // requireTenantApi hands back the non-nullable groupId and the actor's id without a second
  // hand-rolled session read. A local `if (!user?.id)` here would be the 57th guard.
  const vis = await requireAdminApi(req, res);
  if (!vis) return; // it has already answered 401/403
  const scope = await requireTenantApi(req, res);
  if (!scope) return;
  const actorId = scope.userId;

  const b = (req.body || {}) as Record<string, unknown>;
  const correctsId = String(b.correctsId ?? '');
  if (!correctsId) return res.status(400).json({ message: 'correctsId is required.' });
  const startedAt = when(b.startedAt);
  const endedAt = when(b.endedAt);
  if (startedAt === 'bad' || endedAt === 'bad') return res.status(400).json({ message: 'A time is not a date.' });
  if (!startedAt) return res.status(400).json({ message: 'A correction needs a start time.' });

  // TENANT SCOPE, before anything is written. A session id from another garage is a 404, not a 403.
  const target = await prisma.jobClockSession.findFirst({
    where: { id: correctsId, group_id: scope.groupId },
    select: { id: true },
  });
  if (!target) return res.status(404).json({ message: 'Not found.' });

  const out = await correctSession({ correctsId, byUserId: actorId, reason: b.reason, startedAt, endedAt });
  if ('refused' in out) return res.status(400).json({ message: out.refused });
  return res.status(200).json({ ok: true, id: out.id });
}
