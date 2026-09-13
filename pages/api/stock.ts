/**
 * File: pages/api/stock.ts
 * The stock list, taking a car in, and recording how it left. Tenant-scoped through requireTenantApi
 * — the chokepoint, not a copy of the guard.
 *
 * THE V5C REFERENCE IS WRITE-ONLY THROUGH THIS ROUTE. It is accepted on POST and never returned by
 * GET, never echoed in a refusal, and stripped from every audit diff by lib/redact. A logbook number
 * transfers keepership; the garage needs to hold it, and nothing needs to hand it back out. If a
 * screen ever has to display it, that is a new decision with its own guard — not a field added to
 * this response. `redaction-gate` asserts the absence rather than trusting this paragraph.
 *
 * NOT admin-only, by the same reasoning as the purchase model: buying and selling cars is the job of
 * whoever is doing it, and nothing here exposes a figure from the garage's own accounts. The stock
 * BOOK is a different question — it is a compliance document and lives on its own route when built.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { requireTenantApi } from '@/lib/admin-guard';
import { findOrCreateVehicle, recordDisposal, stockList, takeIntoStock } from '@/lib/stock-store';
import { parseStatedDate } from '@/lib/stock-intake';

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
    //
    // The auction-invoice facts about the CAR go here, with it. They outlive this purchase — the VIN,
    // when it was first registered, whether it was imported, the logbook number — so they belong to
    // the vehicle and not to the stock record, which is only this one episode of owning it.
    const vehicle = await findOrCreateVehicle({
      groupId: scope.groupId, registration: String(b.registration ?? ''),
      make: typeof b.make === 'string' ? b.make : null,
      model: typeof b.model === 'string' ? b.model : null,
      vin: b.vin,
      firstRegistered: parseStatedDate(b.firstRegistered),
      motExpiry: parseStatedDate(b.motExpiry),
      isImport: b.isImport,
      v5cReference: b.v5cReference,
      acquiredAt,
    });
    if ('refused' in vehicle) return res.status(400).json({ message: vehicle.refused });

    const out = await takeIntoStock({
      groupId: scope.groupId, userId: scope.userId, vehicleId: vehicle.id, acquiredAt,
      purchasePence: b.purchasePence, vatStatus: b.vatStatus, source: b.source,
      premiumPence: b.premiumPence, servicesPence: b.servicesPence,
      mileageMiles: b.mileageMiles, mileageWarranted: b.mileageWarranted,
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
const parseDate = parseStatedDate;  // ONE date rule. Two would drift, and the drift would be a day.
