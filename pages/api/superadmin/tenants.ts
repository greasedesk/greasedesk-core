/**
 * File: pages/api/superadmin/tenants.ts
 * The region-scoped tenant read for the Engine Room (foundation callsite for layer 1; the full tenant
 * screens come with the Engine Room layer). Proves the boundary the operator guard exists to hold:
 *
 *   • GET (no id)   → tenants the operator may see, filtered by operatorTenantScope (owner: all;
 *                     country manager / support: their regions). The scope is derived from the
 *                     SESSION PRINCIPAL — any ?country / ?region on the request is IGNORED, so a
 *                     Country Manager cannot widen their view by forging a param.
 *   • GET ?id=<g>   → one tenant, but ONLY if it is in scope; out-of-region → 404 (undiscoverable),
 *                     never 403. requireOperatorApi({ tenantId }) enforces this.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi, operatorTenantScope } from '@/lib/operator-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }

  const id = typeof req.query.id === 'string' ? req.query.id : null;

  if (id) {
    // Single tenant: the guard applies the region check (404 if out-of-scope).
    const op = await requireOperatorApi(req, res, { tenantId: id });
    if (!op) return; // 404 already written (not an operator, or out-of-region tenant)
    const g = await prisma.group.findUnique({
      where: { id },
      select: { id: true, ref: true, group_name: true, tax_country_code: true, status: true, archived_at: true, trial_ends_at: true },
    });
    if (!g) return res.status(404).json({ message: 'Not found.' });
    return res.status(200).json({ tenant: g });
  }

  // List: scope is SESSION-DERIVED. Note we deliberately read NO region/country from req.query —
  // the fragment comes only from the principal, so a forged ?country changes nothing.
  const op = await requireOperatorApi(req, res);
  if (!op) return;
  const where = operatorTenantScope(op);
  const tenants = await prisma.group.findMany({
    where,
    orderBy: { created_at: 'asc' },
    select: { id: true, ref: true, group_name: true, tax_country_code: true, status: true, archived_at: true },
  });
  return res.status(200).json({
    scope: op.role === 'owner' ? 'all' : op.regions,
    count: tenants.length,
    tenants,
  });
}
