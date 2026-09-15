/**
 * File: lib/stock-projection.ts
 *
 * WHAT THIS CAR WILL MAKE, on real figures rather than sliders.
 *
 * The purchase model already knows the arithmetic — margin versus qualifying, the buyer's premium
 * inside the margin base, the floor at zero, per-cost VAT recoverability. NONE of it is reimplemented
 * here. This module's whole job is the MAPPING: it turns a stock record and what has actually accrued
 * against it into `ModelInputs`, calls `computeModel`, and is honest about the inputs it cannot fill.
 *
 * ── THE SUBSTITUTIONS, EACH ONE A DELIBERATE CHOICE ─────────────────────────────────────────────
 *
 *   partsPence          REAL. The trade cost of parts fitted on prep cards linked to this car — not a
 *                       slider, not an estimate. This is the point of the exercise.
 *   daysInStock         REAL. Counted from the acquisition date the garage stated.
 *   purchase / premium / services / vatStatus / source
 *                       REAL, off the stock record, exactly as captured at purchase.
 *   salePence           STATED. The garage's own estimate; NULL means no projection at all.
 *
 *   prepHours           ZERO, and workshopCostPerHourPence ZERO with it. Labour is not costed here for
 *                       the same reason it is not costed in the book: there is no measured workshop
 *                       rate, and a typed one would look like a measurement. BOTH are zeroed rather
 *                       than one, so no future edit to a default can quietly reintroduce a labour cost.
 *
 * ── AND THE COSTS THAT HAVE NOWHERE TO LIVE YET ─────────────────────────────────────────────────
 *
 * Delivery in, valeting and MOT now have a home (lib/stock-cost) and arrive REAL, net of credits and
 * net of recoverable VAT. Two do not, each for its own reason: ADVERTISING is an apportioned share of
 * a platform's slots rather than a direct cost, and a WARRANTY PROVISION is a forecast until a claim
 * is paid. Both enter as ZERO, so this projection is still OPTIMISTIC by whatever they come to — and a
 * number optimistic in a way the reader cannot see is worse than no number, so `missingCostKinds`
 * names them and the surface prints them beside the figure.
 */
import {
  computeModel, defaultCostVat, type ModelInputs, type ModelResult, type PurchaseSource, type VatStatus,
} from '@/lib/purchase-model';
import { LABOUR_AT_ZERO_NOTE } from '@/lib/stock';

/** The cost kinds the purchase model can price and a stock item currently cannot record. */
export const MISSING_COST_KINDS = ['Advertising', 'Warranty'] as const;

export const PROJECTION_BASIS_NOTE =
  'Purchase, fees, parts and costs are what this car has actually cost, net of anything credited back. '
  + `${LABOUR_AT_ZERO_NOTE} `
  + `And ${MISSING_COST_KINDS.join(' and ').toLowerCase()} are not recorded against a car: advertising is an apportioned slot share rather than a direct cost, and a warranty provision is a forecast until a claim is paid. So this figure is better than the truth by whatever those come to.`;

export type ProjectionSubject = {
  purchasePence: number;
  premiumPence: number;
  servicesPence: number;
  vatStatus: string;
  source: string;
  daysInStock: number;
  /** REAL accrued parts, at trade cost, from lib/stock-prep. */
  partsPence: number;
  /**
   * REAL non-parts costs — delivery in, valeting, MOT — NET of credits and NET of recoverable VAT
   * (lib/stock-cost). Already the cost BORNE, so it enters the model as a no-VAT figure: putting a
   * net number through a recoverable treatment would reclaim the VAT a second time.
   */
  otherCostsPence?: number;
  /** The garage's estimate. NULL = no projection. */
  projectedSalePence: number | null;
};

export type Projection = {
  salePence: number;
  /** The model's own answer — gross profit on this car, before fixed monthly costs and tax. */
  grossProfitPence: number;
  /** Everything the model counted as a cost, so the figure can be taken apart. */
  totalCostsPence: number;
  vatDuePence: number;
  partsPence: number;
  /** What is NOT in it. Never empty while those costs have no home; print it beside the number. */
  missingCostKinds: readonly string[];
  note: string;
};

/**
 * NULL IN, NULL OUT. A car with no stated sale price has no projection — not a £0 one. Returning a
 * loss for every car nobody has estimated would be a confident wrong answer, and those are the ones
 * that get believed.
 */
export function projectStock(s: ProjectionSubject, opts: { vatRegistered: boolean }): Projection | null {
  if (s.projectedSalePence === null || !(s.projectedSalePence > 0)) return null;

  const inputs: ModelInputs = {
    purchasePence: s.purchasePence,
    salePence: s.projectedSalePence,
    vatStatus: s.vatStatus as VatStatus,
    source: s.source as PurchaseSource,
    premiumPence: s.premiumPence,
    servicesPence: s.servicesPence,
    // A margin car has no reclaimable VAT in its purchase by definition, and a qualifying car's
    // purchase price is captured gross like every other figure in this product.
    purchaseIncludesVat: true,
    // deliveryInPence carries the real non-parts costs and is forced to no_vat, because that figure
    // arrives NET of recovery from lib/stock-cost. Everything else keeps the conservative defaults.
    costVat: { ...defaultCostVat(), deliveryInPence: 'no_vat' },
    // UNKNOWN, so NOT MODELLED. The stock record does not say how the car was paid for and inventing
    // a funding plan would put an interest charge on a car somebody bought with cash.
    funding: { kind: 'cash' },
    slotCostPerMonthPence: 0,

    partsPence: s.partsPence,          // REAL
    daysInStock: s.daysInStock,        // REAL
    prepHours: 0,                      // labour uncosted — see the header
    workshopCostPerHourPence: 0,       // …and belt-and-braces, so a default cannot reintroduce it
    advertisingPence: 0,
    warrantyPence: 0,
    deliveryInPence: Math.max(0, Math.round(s.otherCostsPence ?? 0)),
    deliveryOutPence: 0,
    costOfMoneyAnnualPct: 0,
  };

  const r: ModelResult = computeModel(inputs, { vatRegistered: opts.vatRegistered });
  return {
    salePence: s.projectedSalePence,
    grossProfitPence: r.grossProfitPence,
    totalCostsPence: r.totalCostsPence,
    vatDuePence: r.vatDuePence,
    partsPence: s.partsPence,
    missingCostKinds: MISSING_COST_KINDS,
    note: PROJECTION_BASIS_NOTE,
  };
}
