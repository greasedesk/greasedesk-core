/**
 * File: pages/api/purchase-model-defaults.ts
 * THE GARAGE'S STANDING ANSWERS about how its suppliers charge VAT. Tenant-scoped through
 * requireTenantApi — the chokepoint, not a copy of the guard.
 *
 * NOT admin-only, by the same reasoning as the model itself: this says whether the paint shop adds VAT
 * to its invoices, which is a fact about a supplier rather than a figure from the garage's accounts.
 *
 * GET is not offered. The page is server-rendered and already receives the defaults as a prop, so an
 * endpoint returning them would be a second way to learn the same thing and a second thing to keep
 * right. Only the write needs a route.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantApi } from '@/lib/admin-guard';
import { setPurchaseDefaults } from '@/lib/purchase-model-defaults';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const scope = await requireTenantApi(req, res);
  if (!scope) return; // it has already answered 401

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  const body = (req.body || {}) as Record<string, unknown>;
  // The store normalises: anything it does not recognise is dropped rather than stored, so a bad POST
  // cannot leave a row that lies about what it holds.
  // EITHER HALF, OR BOTH. An omitted half keeps what is stored rather than clearing it — the supplier
  // answers and the advertising package are saved from different parts of the page.
  const saved = await setPurchaseDefaults({
    groupId: scope.groupId, userId: scope.userId,
    costVat: 'costVat' in body ? body.costVat : undefined,
    advertising: 'advertising' in body ? body.advertising : undefined,
  });
  return res.status(200).json({ ok: true, ...saved });
}
