/**
 * File: pages/api/company.ts
 * Edit the caller's own Group (company) details. ADMIN/owner only — gated server-side via the
 * same getVisibility().isAdmin check used for user-management / location-create. Group-scoped.
 *
 *   PATCH { group_name?, company_number?, vat_number?, vat_registered? }
 *
 * vat_registered is the master switch gating VAT across quotes/invoices/overheads (lib/tenant-vat.ts).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const sUser = session?.user as any;
  if (!sUser?.id || !sUser?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vis = await getVisibility(sUser.id as string);
  if (!vis.isAdmin) {
    return res.status(403).json({ message: 'Only an admin can edit company details.' });
  }
  const groupId = sUser.group_id as string;

  const { group_name, company_number, vat_number, vat_registered } = (req.body || {}) as {
    group_name?: string; company_number?: string; vat_number?: string; vat_registered?: boolean;
  };

  const data: any = {};
  if (group_name !== undefined) {
    const clean = group_name.trim();
    if (!clean) return res.status(400).json({ message: 'Company name cannot be empty.' });
    data.group_name = clean;
  }
  if (company_number !== undefined) data.company_number = company_number.trim() || null;
  if (vat_number !== undefined) data.vat_number = vat_number.trim() || null;
  if (vat_registered !== undefined) data.vat_registered = !!vat_registered;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: 'Nothing to update.' });
  }

  await prisma.group.update({ where: { id: groupId }, data });
  return res.status(200).json({ message: 'Company details saved.' });
}
