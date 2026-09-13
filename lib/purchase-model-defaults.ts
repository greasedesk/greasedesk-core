/**
 * File: lib/purchase-model-defaults.ts
 * WHAT THIS GARAGE'S SUPPLIERS DO, REMEMBERED — the one reader and the one writer.
 *
 * A garage's paint shop is not VAT registered this week and will not be next week either, so asking on
 * every car is friction for an answer that is nearly always the same. But one car can go to a registered
 * bodyshop, so this only SEEDS a model: the per-model answers live in the model's own inputs and are
 * what the arithmetic reads. Nothing here is ever read during a calculation.
 *
 * ── WHY THE SEED IS NOT THE TRUTH ───────────────────────────────────────────────────────────────
 * If computeModel read the tenant row, changing a standing answer would silently rewrite every saved
 * model's result — a fact about the business retro-fitted into documents about cars. The same reason
 * `vatRegistered` is passed to computeModel as an option rather than stored in a model's inputs.
 *
 * ── SCOPED TO THE PURCHASE MODEL, DELIBERATELY ──────────────────────────────────────────────────
 * This is not a general tenant-settings store and does not pretend to be. Whether the Autotrader
 * package belongs beside these answers is a separate decision; this table existing does not make it.
 */
import { prisma } from '@/lib/db';
import {
  FLAGGED_COSTS, VAT_TREATMENTS, defaultCostVat, emptyAdvertisingPackage,
  type AdvertisingPackage, type FlaggedCost, type VatTreatment,
} from '@/lib/purchase-model';

export type CostVatMap = Record<FlaggedCost, VatTreatment>;

/**
 * NORMALISE ON READ, always. The column is JSONB written by whatever deploy was live at the time, so a
 * key this build does not know is ignored and a key it knows but the row lacks falls back to the
 * default — which is the conservative, byte-identical-to-today answer. A newer deploy writing a fourth
 * treatment cannot break an older reader; it just reads as the default until that deploy arrives.
 */
export function normaliseCostVatMap(raw: unknown): CostVatMap {
  const given = (raw ?? {}) as Record<string, unknown>;
  const out = defaultCostVat();
  for (const k of FLAGGED_COSTS) {
    if ((VAT_TREATMENTS as readonly string[]).includes(String(given[k]))) out[k] = given[k] as VatTreatment;
  }
  return out;
}

/** The garage's standing answers, or the defaults when it has never said. Never throws on bad JSON. */
export async function getCostVatDefaults(groupId: string): Promise<CostVatMap> {
  const row = await prisma.purchaseModelDefaults.findUnique({
    where: { group_id: groupId },
    select: { cost_vat: true },
  });
  return normaliseCostVatMap(row?.cost_vat ?? null);
}

/**
 * ── THE ADVERTISING PACKAGE ─────────────────────────────────────────────────────────────────────
 * Monthly cost, slot count, and how many cars are in stock. The per-slot figure is DERIVED from the
 * first two and never typed, so a garage cannot hold two different answers for what a slot costs.
 *
 * UNRECOGNISED KEYS ARE IGNORED, which is what lets the two unanswered contract questions arrive by
 * deploy rather than migration: a newer build writing `pxSlots` or `granularity` leaves this reader
 * unbothered, and it reads them the day it understands them.
 *
 * Zeros mean "not described", and nothing is inferred from them — no slot cost is charged at all.
 */
export function normaliseAdvertising(raw: unknown): AdvertisingPackage {
  const g = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown, cap: number) => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) && x > 0 ? Math.min(cap, Math.round(x)) : 0;
  };
  return {
    monthlyPence: n(g.monthlyPence, 100000000),
    slots: n(g.slots, 5000),
    carsInStock: n(g.carsInStock, 5000),
  };
}

/** The garage's package, or an empty one. Never throws on bad JSON. */
export async function getAdvertisingPackage(groupId: string): Promise<AdvertisingPackage> {
  const row = await prisma.purchaseModelDefaults.findUnique({
    where: { group_id: groupId }, select: { advertising: true },
  });
  return row?.advertising ? normaliseAdvertising(row.advertising) : emptyAdvertisingPackage();
}

/**
 * BOTH STANDING ANSWERS IN ONE WRITE, because they live in one row and a second upsert would be a
 * second way for the row to be half-written. Either half may be omitted and keeps what is stored.
 */
export async function setPurchaseDefaults(args: {
  groupId: string; userId: string; costVat?: unknown; advertising?: unknown;
}): Promise<{ costVat: CostVatMap; advertising: AdvertisingPackage }> {
  const existing = await prisma.purchaseModelDefaults.findUnique({
    where: { group_id: args.groupId }, select: { cost_vat: true, advertising: true },
  });
  const costVat = normaliseCostVatMap(args.costVat === undefined ? existing?.cost_vat ?? null : args.costVat);
  const advertising = normaliseAdvertising(
    args.advertising === undefined ? existing?.advertising ?? null : args.advertising,
  );
  await prisma.purchaseModelDefaults.upsert({
    where: { group_id: args.groupId },
    create: { group_id: args.groupId, cost_vat: costVat, advertising, updated_by_user_id: args.userId },
    update: { cost_vat: costVat, advertising, updated_by_user_id: args.userId },
  });
  return { costVat, advertising };
}
