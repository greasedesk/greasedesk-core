/**
 * File: pages/api/purchase-model.ts
 * Save, list, open and delete a purchase model. Tenant-scoped through requireTenantApi — the
 * chokepoint, not a copy of the guard.
 *
 * NOT admin-only. Deciding what to pay for a car is the job of whoever is at the auction, and the
 * model contains no figure from the garage's own accounts — every number in it was typed or dragged
 * by the person looking at the screen.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantApi } from '@/lib/admin-guard';
import { saveModel, listModels, getModel, removeModel } from '@/lib/purchase-model-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const scope = await requireTenantApi(req, res);
  if (!scope) return; // it has already answered 401

  if (req.method === 'GET') {
    const id = typeof req.query.id === 'string' ? req.query.id : null;
    if (!id) return res.status(200).json({ models: await listModels(scope.groupId) });
    const model = await getModel(scope.groupId, id);
    if (!model) return res.status(404).json({ message: 'Not found.' });
    return res.status(200).json({ model });
  }

  if (req.method === 'POST') {
    const b = (req.body || {}) as Record<string, unknown>;
    const out = await saveModel({
      groupId: scope.groupId, userId: scope.userId,
      id: typeof b.id === 'string' ? b.id : null,
      label: b.label, vehicleIdent: b.vehicleIdent, inputs: b.inputs,
    });
    if ('refused' in out) return res.status(400).json({ message: out.refused });
    return res.status(200).json({ ok: true, id: out.id });
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) return res.status(400).json({ message: 'id is required.' });
    return res.status(await removeModel(scope.groupId, id) ? 200 : 404).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
