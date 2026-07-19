/**
 * File: lib/import-memory.ts
 * LINE MEMORY — the seed of the catalogue, not a throwaway import table.
 *
 * Keyed on description + unit_price because the SAME description at a different price is a
 * DIFFERENT job. TMBS May 2026 proves it: "Change Oil using 100% Synthetic engine oil" appears at
 * 125, 165 and 233.3333 — three engine tiers. Keyed on description alone, one cost would have been
 * entered and been wrong for two of them.
 *
 * COST BOUNDARY (ruling: the browser is not a source of trade-cost figures). The wizard never
 * writes cost onto a job-card line. It writes cost to the CATALOGUE, and lines inherit. A line with
 * no catalogue entry keeps unit_cost NULL — unknown, never zero — and surfaces in the existing
 * uncostedParts exposure rather than silently inflating margin.
 */
import { prisma } from '@/lib/db';
import type { Prisma, ItemType } from '@prisma/client';

export type MemoryHit = {
  catalogueItemId: string;
  code: string;
  title: string;
  itemType: ItemType;
  unitCostPennies: number | null;
  labourHours: number | null;
  active: boolean;
  via: 'alias' | 'catalogue-code';
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Resolve one parsed line against memory. Alias first (it carries the operator's own aliasing
 * decisions), then an exact catalogue code match. A miss is a genuine miss — we do NOT fuzzy-match
 * here, because a wrong auto-resolve silently attaches the wrong cost to real money.
 */
export async function resolveLine(
  groupId: string,
  description: string,
  unitPrice: number,
): Promise<MemoryHit | null> {
  const price = round4(unitPrice);

  const alias = await prisma.catalogueAlias.findFirst({
    where: {
      group_id: groupId,
      description,
      OR: [{ unit_price: price as any }, { unit_price: null }],
    },
    orderBy: { unit_price: 'desc' }, // an exact-price alias beats the any-price one
    include: { item: true },
  });
  if (alias?.item) {
    const it = alias.item as any;
    return {
      catalogueItemId: it.id,
      code: it.code,
      title: it.title ?? it.name ?? it.code,
      itemType: it.item_type,
      unitCostPennies: it.unit_cost == null ? null : Math.round(Number(it.unit_cost) * 100),
      labourHours: it.labour_hours == null ? null : Number(it.labour_hours),
      active: !!it.active,
      via: 'alias',
    };
  }
  return null;
}

/** Deterministic catalogue code from a description + price, stable across re-runs. */
export function codeFor(description: string, unitPrice: number): string {
  const slug = description.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const p = String(Math.round(unitPrice * 100));
  return `IMP-${slug}-${p}`;
}

/**
 * Create (or reuse) the catalogue entry behind a costed line, plus its alias.
 *
 * ACTIVE RULE (operator's call): a description+price seen MORE THAN ONCE across the batch lands
 * active — it is established work. Seen exactly ONCE lands active=false: costed and joinable, but
 * kept out of the quoting picker until deliberately promoted. This stops a month of one-off repairs
 * flooding the picker with 43 entries nobody will pick again.
 */
export async function upsertMemory(
  tx: Prisma.TransactionClient,
  args: {
    groupId: string;
    description: string;
    unitPrice: number;
    itemType: ItemType;
    unitCostPennies: number | null;
    labourHours: number | null;
    timesSeen: number;
    vatRate: number;
  },
): Promise<string> {
  const code = codeFor(args.description, args.unitPrice);
  const active = args.timesSeen > 1;

  const existing = await tx.catalogueItem.findFirst({
    where: { group_id: args.groupId, code },
    select: { id: true },
  });

  const data = {
    group_id: args.groupId,
    code,
    title: args.description.slice(0, 120),
    name: args.description.slice(0, 120),
    item_type: args.itemType,
    unit_price: args.unitPrice as any,
    base_price_ex_vat: args.unitPrice as any,
    unit_cost: (args.unitCostPennies == null ? 0 : args.unitCostPennies / 100) as any,
    labour_hours: (args.labourHours ?? null) as any,
    vat_rate: args.vatRate as any,
    active,
  };

  const item = existing
    ? await tx.catalogueItem.update({ where: { id: existing.id }, data, select: { id: true } })
    : await tx.catalogueItem.create({ data, select: { id: true } });

  await tx.catalogueAlias.upsert({
    where: {
      group_id_description_unit_price: {
        group_id: args.groupId,
        description: args.description,
        unit_price: round4(args.unitPrice) as any,
      },
    },
    create: {
      group_id: args.groupId,
      catalogue_item_id: item.id,
      description: args.description,
      unit_price: round4(args.unitPrice) as any,
      source: 'import',
    },
    update: { catalogue_item_id: item.id },
  });

  return item.id;
}

/** Point an existing description+price at a DIFFERENT canonical item — the operator's aliasing. */
export async function aliasTo(
  groupId: string,
  description: string,
  unitPrice: number | null,
  catalogueItemId: string,
): Promise<void> {
  await prisma.catalogueAlias.upsert({
    where: {
      group_id_description_unit_price: {
        group_id: groupId,
        description,
        unit_price: (unitPrice == null ? null : round4(unitPrice)) as any,
      },
    },
    create: {
      group_id: groupId,
      catalogue_item_id: catalogueItemId,
      description,
      unit_price: (unitPrice == null ? null : round4(unitPrice)) as any,
      source: 'manual',
    },
    update: { catalogue_item_id: catalogueItemId, source: 'manual' },
  });
}
