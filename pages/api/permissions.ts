/**
 * File: pages/api/permissions.ts
 * Per-tenant permission toggles. PATCH { standardEditPricing?, standardDiaryEntries? }.
 * ADMIN/owner only (who-can-do-what is owner-level, NOT site-manager) via requireAdminApi.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const vis = await requireAdminApi(req, res); // 401/403 handled inside
  if (!vis) return;
  if (!vis.groupId) return res.status(400).json({ message: 'No tenant context.' });

  const b = (req.body || {}) as Record<string, boolean | undefined>;
  const data: any = {};
  if (b.standardEditPricing !== undefined) data.perm_standard_edit_pricing = !!b.standardEditPricing;
  if (b.standardDiaryEntries !== undefined) data.perm_standard_diary_entries = !!b.standardDiaryEntries;
  if (b.managerSeeValues !== undefined) data.perm_manager_see_values = !!b.managerSeeValues;
  if (b.managerSeeMargin !== undefined) data.perm_manager_see_margin = !!b.managerSeeMargin;
  if (b.standardSeeValues !== undefined) data.perm_standard_see_values = !!b.standardSeeValues;
  if (b.standardSeeMargin !== undefined) data.perm_standard_see_margin = !!b.standardSeeMargin;
  if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update.' });

  await prisma.group.update({ where: { id: vis.groupId }, data });
  return res.status(200).json({ message: 'Permissions saved.' });
}
