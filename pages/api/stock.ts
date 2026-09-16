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
import { prisma } from '@/lib/db';
import {
  addStockCost, creditStockCost, findOrCreateVehicle, findPriorSale, findVehicleByReg, recordDisposal,
  setStockStatus, soldInPeriod, stockDetail, stockList, takeIntoStock, updateStockItem,
} from '@/lib/stock-store';
import { resolveRange } from '@/lib/dashboard-periods';
import { ALL_TIME_FROM, SOLD_EXTRA_PRESET } from '@/lib/stock-sold';
import { getTaxProfile } from '@/lib/tenant-vat';
import { MUST_CHOOSE_REFUSAL, isReacquisition } from '@/lib/stock-reacquisition';
import { parseStatedDate } from '@/lib/stock-intake';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const scope = await requireTenantApi(req, res);
  if (!scope) return; // it has already answered 401

  if (req.method === 'GET') {
    /**
     * ── HAS THIS CAR BEEN HERE BEFORE? EVIDENCE, NOT A DECISION ────────────────────────────────
     *
     * Returns what it found and NOTHING resembling a recommendation — no suggested source, no
     * `likely`, no default. A match is equally true of a return and of a buyback, which are taxed
     * differently, so anything here that leaned either way would be wrong half the time and silent
     * about it. The person says which; see lib/stock-reacquisition.
     */
    if (typeof req.query.priorSaleFor === 'string' && req.query.priorSaleFor.trim()) {
      // findVehicleByReg, NOT find-or-create: asking whether a car has been here before must not
      // create it. A lookup with a side effect is how a typo becomes a vehicle record.
      const veh = await findVehicleByReg(scope.groupId, req.query.priorSaleFor);
      return res.status(200).json({ priorSale: veh ? await findPriorSale(scope.groupId, veh.id) : null });
    }
    // THE TENANT's VAT status, not GreaseDesk's — the projection's margin-vs-qualifying arithmetic
    // turns on it. getTaxProfile, never garageVatRegistered(), which is our own registration.
    const vatRegistered = (await getTaxProfile(scope.groupId)).isRegistered;

    /**
     * THE SOLD REPORT. Periods come from lib/dashboard-periods — the SAME vocabulary and the same
     * FY-aware resolver the main dashboard uses, because a second period vocabulary would drift and
     * the two screens would eventually disagree about what "last quarter" means.
     *
     * `all_time` is the one addition, resolved here rather than added to that module: it is a stock
     * question, not a dashboard one, and every preset there assumes enough history for a month to
     * mean something.
     */
    if (req.query.sold === '1') {
      // THE TENANT'S OWN FINANCIAL YEAR, read from Group where it lives — not defaulted to April.
      // A cast onto the tax profile compiled fine and would have silently given every tenant an
      // April year-end, which is wrong for anyone whose year does not start there.
      const g = await prisma.group.findUnique({
        where: { id: scope.groupId }, select: { fy_start_month: true },
      });
      const preset = typeof req.query.preset === 'string' ? req.query.preset : 'this_fy';
      const range = preset === SOLD_EXTRA_PRESET
        ? { from: ALL_TIME_FROM, to: new Date() }
        : resolveRange({ preset, from: req.query.from as string, to: req.query.to as string },
          g?.fy_start_month ?? 4);
      if (!range) return res.status(400).json({ message: 'That period is not one we can work out.' });
      const out = await soldInPeriod(scope.groupId, range.from, range.to);
      return res.status(200).json({ ...out, preset, from: range.from, to: range.to });
    }

    if (typeof req.query.id === 'string' && req.query.id) {
      const detail = await stockDetail(scope.groupId, req.query.id, new Date(), { vatRegistered });
      if (!detail) return res.status(404).json({ message: 'That car is not on this account.' });
      return res.status(200).json({ detail });
    }
    // `asOf` is the server's clock, once, so every row's days-in-stock is counted from one instant.
    return res.status(200).json({ stock: await stockList(scope.groupId, new Date(), { vatRegistered }) });
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

    if (b.action === 'set-status') {
      const out = await setStockStatus({
        groupId: scope.groupId, stockItemId: String(b.stockItemId ?? ''),
        status: b.status, arrivedAt: parseDate(b.arrivedAt),
      });
      if ('refused' in out) return res.status(409).json({ message: out.refused });
      return res.status(200).json({ ok: true, id: out.id, status: out.status });
    }

    if (b.action === 'add-cost') {
      const out = await addStockCost({
        groupId: scope.groupId, userId: scope.userId, stockItemId: String(b.stockItemId ?? ''),
        kind: b.kind, description: b.description, amountPence: b.amountPence,
        incurredOn: parseDate(b.incurredOn), vatTreatment: b.vatTreatment,
      });
      if ('refused' in out) return res.status(409).json({ message: out.refused });
      return res.status(200).json({ ok: true, id: out.id });
    }

    if (b.action === 'credit-cost') {
      const out = await creditStockCost({
        groupId: scope.groupId, userId: scope.userId, stockItemId: String(b.stockItemId ?? ''),
        reversesId: String(b.reversesId ?? ''), amountPence: b.amountPence,
        incurredOn: parseDate(b.incurredOn), description: b.description,
      });
      if ('refused' in out) return res.status(409).json({ message: out.refused });
      return res.status(200).json({ ok: true, id: out.id });
    }

    if (b.action === 'update') {
      const out = await updateStockItem({
        groupId: scope.groupId, stockItemId: String(b.stockItemId ?? ''),
        acquiredAt: parseDate(b.acquiredAt),
        purchasePence: b.purchasePence, premiumPence: b.premiumPence, servicesPence: b.servicesPence,
        mileageWarranted: b.mileageWarranted, projectedSalePence: b.projectedSalePence,
        // Passed through ONLY so the writer can refuse them by name — see updateStockItem.
        vatStatus: b.vatStatus, source: b.source,
      });
      if ('refused' in out) return res.status(409).json({ message: out.refused });
      return res.status(200).json({ ok: true, id: out.id });
    }

    const acquiredAt = parseDate(b.acquiredAt);
    if (!acquiredAt) return res.status(400).json({ message: 'Say when you bought it.' });

    /**
     * NO DEFAULT, EVER. If the body arrives naming neither source, this route does not pick one from
     * the fact that a match exists — it refuses. A default here would be right about half the time
     * and wrong silently the rest, on precisely the half that reduces a VAT bill.
     */
    if (b.reacquiredFromDisposalId && !isReacquisition(b.source)) {
      return res.status(400).json({ message: MUST_CHOOSE_REFUSAL });
    }
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
      // WHERE IT STARTS, stated. A car bought for Friday collection starts due_in and has no arrival
      // date yet; anything else arrived the day it was bought unless told otherwise.
      status: b.status, arrivedAt: parseDate(b.arrivedAt),
      reacquiredFromDisposalId: typeof b.reacquiredFromDisposalId === 'string' ? b.reacquiredFromDisposalId : null,
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
