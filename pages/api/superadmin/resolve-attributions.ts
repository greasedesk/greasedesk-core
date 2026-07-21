/**
 * File: pages/api/superadmin/resolve-attributions.ts
 * ATTRIBUTION RESOLUTION — operator-triggered (trigger 2 of 2). OWNER-ONLY, server-enforced (any
 * non-owner — CM/support/wrong class — gets 404, matching the rest of the platform-management
 * surface), audited. This is the Engine Room "confirm/resolve attribution" action: it drives the
 * lib/attribution chokepoint over stored signup_refs. It never writes attribution logic of its own —
 * the chokepoint owns the rule, and Group.signup_ref is never touched.
 *
 * POST { repId? }:
 *   • repId given → resolve every group carrying that Rep's ref_code (the deferred path made manual).
 *   • no body     → resolveAllPending: sweep every ref-carrying group with no attribution yet.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { resolveAttributionsForRep, resolveAllPending } from '@/lib/attribution';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  // Undiscoverable to non-owners: any operator (else 404), then 404 a non-owner — never a 403.
  const actor = await requireOperatorApi(req, res);
  if (!actor) return;
  if (actor.role !== 'owner') { res.status(404).json({ message: 'Not found.' }); return; }

  const repId = String((req.body || {}).repId ?? '').trim() || null;
  const result = repId
    ? await resolveAttributionsForRep(prisma, repId, { createdBy: actor.userId })
    : await resolveAllPending(prisma, { createdBy: actor.userId });

  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: actor.userId, action: 'attribution.resolved',
      target_group_id: null, target_operator_id: null,
      target_name_snapshot: repId ? `rep:${repId}` : 'all-pending',
      detail: (result as any) ?? Prisma.JsonNull,
    },
  });
  return res.status(200).json({ ok: true, ...result, message: `Resolved — ${result.created} attribution(s) written.` });
}
