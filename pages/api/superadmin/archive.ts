/**
 * File: pages/api/superadmin/archive.ts
 * SuperAdmin: archive (soft-delete) / un-archive a tenant. POST { groupId, action:'archive'|'unarchive', confirmTmbs? }.
 * Operator-only (404 to everyone else). Reversible. Guards: can't archive the operator's OWN tenant;
 * TMBS needs confirmTmbs:true (second explicit confirmation). Every action writes SuperAdminAudit.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireSuperAdminApi, TMBS_GROUP_ID } from '@/lib/superadmin';
import { archiveTenant, unarchiveTenant } from '@/lib/tenant-purge';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const operatorUserId = await requireSuperAdminApi(req, res); if (!operatorUserId) return; // 404 if not operator

  const { groupId, action, confirmTmbs } = (req.body || {}) as { groupId?: string; action?: string; confirmTmbs?: boolean };
  if (!groupId || (action !== 'archive' && action !== 'unarchive')) return res.status(400).json({ message: 'groupId and a valid action are required.' });

  const target = await prisma.group.findUnique({ where: { id: groupId }, select: { id: true, group_name: true } });
  if (!target) return res.status(404).json({ message: 'Tenant not found.' });

  // Guard: never the operator's OWN tenant.
  const operator = await prisma.user.findUnique({ where: { id: operatorUserId }, select: { group_id: true } });
  if (operator?.group_id === groupId) return res.status(409).json({ message: 'You cannot archive your own tenant.' });

  // Guard: TMBS (live dogfood) needs a second explicit confirmation.
  if (groupId === TMBS_GROUP_ID && confirmTmbs !== true) return res.status(409).json({ code: 'tmbs_confirm', message: 'This is the live TMBS tenant — confirm again to proceed.' });

  try {
    const out = action === 'archive' ? await archiveTenant(operatorUserId, groupId) : await unarchiveTenant(operatorUserId, groupId);
    return res.status(200).json({ ok: true, action, groupId, ...out });
  } catch (e: any) {
    console.error('[superadmin] archive error', e?.message);
    return res.status(500).json({ message: 'Archive failed.' });
  }
}
