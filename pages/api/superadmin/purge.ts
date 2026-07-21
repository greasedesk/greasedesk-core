/**
 * File: pages/api/superadmin/purge.ts
 * SuperAdmin: PURGE (hard, irreversible) a tenant. POST { groupId, confirmName, confirmTmbs? }.
 * Operator-only (404 to everyone else). Guards: can't purge the operator's OWN tenant; confirmName
 * must match the target's name EXACTLY (targets by id, never name); TMBS needs confirmTmbs:true.
 * Cancels Stripe, deletes R2 by prefix, ordered DB deletion, writes SuperAdminAudit. See lib/tenant-purge.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { TMBS_GROUP_ID } from '@/lib/superadmin';
import { requireOperatorApi } from '@/lib/operator-auth';
import { purgeTenant } from '@/lib/tenant-purge';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const { groupId, confirmName, confirmTmbs } = (req.body || {}) as { groupId?: string; confirmName?: string; confirmTmbs?: boolean };
  if (!groupId || !confirmName) return res.status(400).json({ message: 'groupId and confirmName are required.' });

  // Purge is OWNER-ONLY and region-scoped (out-of-region → 404). CM and Support 404 here.
  const op = await requireOperatorApi(req, res, { minRole: 'owner', tenantId: groupId });
  if (!op) return;

  const target = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true, group_name: true } });
  if (!target) return res.status(404).json({ message: 'Tenant not found.' });

  // Guard: typed name must match EXACTLY (we still target by id).
  if (confirmName.trim() !== target.group_name) return res.status(409).json({ code: 'name_mismatch', message: 'The typed name does not match this tenant.' });

  // Guard: TMBS (live dogfood) needs a second explicit confirmation.
  if (groupId === TMBS_GROUP_ID && confirmTmbs !== true) return res.status(409).json({ code: 'tmbs_confirm', message: 'This is the live TMBS tenant — confirm again to proceed.' });

  try {
    const result = await purgeTenant(op.userId, groupId);
    return res.status(200).json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[superadmin] purge error', e?.message);
    return res.status(500).json({ message: 'Purge failed.', detail: e?.message });
  }
}
