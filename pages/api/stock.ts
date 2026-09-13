/**
 * File: pages/api/stock.ts
 * The stock list, taking a car in, and recording how it left. Tenant-scoped through requireTenantApi
 * — the chokepoint, not a copy of the guard.
 *
 * NOT admin-only, by the same reasoning as the purchase model: buying and selling cars is the job of
 * whoever is doing it, and nothing here exposes a figure from the garage's own accounts. The stock
 * BOOK is a different question — it is a compliance document and lives on its own route when built.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantApi } from '@/lib/admin-guard';
import { findOrCreateVehicle, recordDisposal, stockList, takeIntoStock } from '@/lib/stock-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const scope = await requireTenantApi(req, res);
  if (!scope) return; // it has already answered 401

  if (req.method === 'GET') {
    // `asOf` is the server's clock, once, so every row's days-in-stock is counted from one instant.
    return res.status(200).json({ stock: await stockList(scope.groupId, new Date()) });
  }

  if (req.method === 'POST') {
    const b = (req.body || {}) as Record<string, unknown>;

    if (b.action === 'dispose') {
      const disposedAt = parseDate(b.disposedAt);
      if (!disposedAt) return res.status(400).json({ message: 'Say when it left.' });
      const out = await recordDisposal({
        groupId: scope.groupId, userId: scope.userId,
        stockItemId: String(b.stockItemId ?? ''), disposedAt,
        kind: b.kind, salePence: b.salePence, note: b.note,
        costs: Array.isArray(b.costs) ? (b.costs as never[]) : [],
      });
      if ('refused' in out) return res.status(409).json({ message: out.refused });
      return res.status(200).json({ ok: true, id: out.id });
    }

    const acquiredAt = parseDate(b.acquiredAt);
    if (!acquiredAt) return res.status(400).json({ message: 'Say when you bought it.' });
    // THE CAR FIRST. A garage at an auction has a registration and nothing else; making them create
    // the vehicle elsewhere and come back is how a feature gets worked around with a spreadsheet.
    const vehicle = await findOrCreateVehicle({
      groupId: scope.groupId, registration: String(b.registration ?? ''),
      make: typeof b.make === 'string' ? b.make : null,
      model: typeof b.model === 'string' ? b.model : null,
    });
    if ('refused' in vehicle) return res.status(400).json({ message: vehicle.refused });

    const out = await takeIntoStock({
      groupId: scope.groupId, userId: scope.userId, vehicleId: vehicle.id, acquiredAt,
      purchasePence: b.purchasePence, vatStatus: b.vatStatus, source: b.source,
      premiumPence: b.premiumPence, servicesPence: b.servicesPence,
    });
    if ('refused' in out) return res.status(409).json({ message: out.refused });
    return res.status(200).json({ ok: true, id: out.id });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method not allowed.' });
}

/**
 * A DATE THE GARAGE STATED, not a timestamp the server invented. Refused rather than defaulted: the
 * acquisition date sets the book's period boundary and the days-in-stock on every list, so guessing it
 * would put a car in the wrong quarter silently.
 */
function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T12:00:00.000Z`);   // midday UTC: no date shifts either side of midnight
  return Number.isNaN(d.getTime()) ? null : d;
}
