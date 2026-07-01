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

  const { standardEditPricing, standardDiaryEntries } = (req.body || {}) as { standardEditPricing?: boolean; standardDiaryEntries?: boolean };
  const data: any = {};
  if (standardEditPricing !== undefined) data.perm_standard_edit_pricing = !!standardEditPricing;
  if (standardDiaryEntries !== undefined) data.perm_standard_diary_entries = !!standardDiaryEntries;
  if (Object.keys(data).length === 0) return res.status(400).json({ message: 'Nothing to update.' });

  await prisma.group.update({ where: { id: vis.groupId }, data });
  return res.status(200).json({ message: 'Permissions saved.' });
}
