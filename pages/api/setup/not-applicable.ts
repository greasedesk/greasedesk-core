/**
 * File: pages/api/setup/not-applicable.ts
 * Set/clear a setup signal's APPLICABILITY (item-13). ADMIN-only. Scoped to EXACTLY the two signals
 * that can be "not applicable" — employees + company number (a sole trader has neither). This writes
 * an applicability declaration, NEVER a "done" flag — completion stays derived from real rows.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/admin-guard';

const FIELD: Record<string, 'employees_not_applicable' | 'company_number_not_applicable'> = {
  employees: 'employees_not_applicable',
  company_number: 'company_number_not_applicable',
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const vis = await requireAdminApi(req, res); if (!vis) return;
  const groupId = vis.groupId as string;
  if (!groupId) return res.status(400).json({ message: 'No group in scope.' });

  const { signal, notApplicable } = (req.body || {}) as { signal?: string; notApplicable?: boolean };
  const field = signal ? FIELD[signal] : undefined;
  if (!field) return res.status(400).json({ message: 'Only employees or company number can be marked not applicable.' });

  await prisma.group.update({ where: { id: groupId }, data: { [field]: notApplicable === true } });
  return res.status(200).json({ ok: true, signal, notApplicable: notApplicable === true });
}
