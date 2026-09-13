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
  FLAGGED_COSTS, VAT_TREATMENTS, defaultCostVat,
  type FlaggedCost, type VatTreatment,
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
 * REMEMBER THESE. Upsert on the group, which is the primary key — so "which row wins" is not a question
 * this table can be asked. Normalised before writing as well as after reading: a value that would be
 * ignored on read is not worth storing, and storing it would make the row lie about what it means.
 */
export async function setCostVatDefaults(args: {
  groupId: string; userId: string; costVat: unknown;
}): Promise<CostVatMap> {
  const clean = normaliseCostVatMap(args.costVat);
  await prisma.purchaseModelDefaults.upsert({
    where: { group_id: args.groupId },
    create: { group_id: args.groupId, cost_vat: clean, updated_by_user_id: args.userId },
    update: { cost_vat: clean, updated_by_user_id: args.userId },
  });
  return clean;
}
