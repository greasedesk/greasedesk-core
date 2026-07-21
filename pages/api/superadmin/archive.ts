/**
 * File: pages/api/superadmin/archive.ts
 * SuperAdmin: archive (soft-delete) / un-archive a tenant. POST { groupId, action:'archive'|'unarchive', confirmTmbs? }.
 * Operator-only (404 to everyone else). Reversible. Guards: can't archive the operator's OWN tenant;
 * TMBS needs confirmTmbs:true (second explicit confirmation). Every action writes SuperAdminAudit.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { TMBS_GROUP_ID } from '@/lib/superadmin';
import { requireOperatorApi } from '@/lib/operator-auth';
import { archiveTenant, unarchiveTenant } from '@/lib/tenant-purge';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const { groupId, action, confirmTmbs } = (req.body || {}) as { groupId?: string; action?: string; confirmTmbs?: boolean };
  if (!groupId || (action !== 'archive' && action !== 'unarchive')) return res.status(400).json({ message: 'groupId and a valid action are required.' });

  // Archive is a lifecycle action — Country Manager and above, and only within the operator's region
  // (out-of-region → 404, undiscoverable). Support has read-only tenant visibility and 404s here.
  const op = await requireOperatorApi(req, res, { minRole: 'country_manager', tenantId: groupId });
  if (!op) return;

  const target = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true, group_name: true } });
  if (!target) return res.status(404).json({ message: 'Tenant not found.' });

  // Guard: TMBS (live dogfood) needs a second explicit confirmation.
  if (groupId === TMBS_GROUP_ID && confirmTmbs !== true) return res.status(409).json({ code: 'tmbs_confirm', message: 'This is the live TMBS tenant — confirm again to proceed.' });

  try {
    const out = action === 'archive' ? await archiveTenant(op.userId, groupId) : await unarchiveTenant(op.userId, groupId);
    return res.status(200).json({ ok: true, action, groupId, ...out });
  } catch (e: any) {
    console.error('[superadmin] archive error', e?.message);
    return res.status(500).json({ message: 'Archive failed.' });
  }
}
