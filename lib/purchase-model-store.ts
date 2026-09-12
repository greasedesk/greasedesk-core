/**
 * File: lib/purchase-model-store.ts
 * THE ONE WRITER of purchase models. Reads and writes go through here so the denormalised columns
 * and the stored `inputs` can never disagree — they are written from ONE computation.
 *
 * A model is NOT a record and is meant to be changed (see the schema note): saving over one is
 * ordinary, there is no version chain, and nothing freezes.
 */
import { prisma } from '@/lib/db';
import {
  SLIDERS, VAT_STATUSES, MODEL_STATUSES, clampSlider, computeModel, defaultInputs,
  type ModelInputs, type SliderKey, type VatStatus,
} from '@/lib/purchase-model';

/** Whatever arrived over the wire, made safe: every slider clamped to its own definition. */
export function normaliseInputs(raw: unknown): ModelInputs {
  const b = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const d = defaultInputs();
  const out: ModelInputs = {
    purchasePence: Math.max(0, Math.round(num(b.purchasePence, d.purchasePence))),
    salePence: Math.max(0, Math.round(num(b.salePence, d.salePence))),
    vatStatus: (VAT_STATUSES as readonly string[]).includes(String(b.vatStatus)) ? (b.vatStatus as VatStatus) : d.vatStatus,
    ...Object.fromEntries(SLIDERS.map((s) => [s.key, clampSlider(s.key, num(b[s.key], s.def))])) as Record<SliderKey, number>,
  };
  return out;
}

export type SaveArgs = { groupId: string; userId: string; id?: string | null; label: unknown; vehicleIdent: unknown; inputs: unknown };

/** Create or overwrite. Returns the row's id, or a refusal a person can act on. */
export async function saveModel(a: SaveArgs): Promise<{ id: string } | { refused: string }> {
  const label = String(a.label ?? '').trim();
  if (!label) return { refused: 'Give it a name so you can find it again.' };
  if (label.length > 120) return { refused: 'That name is too long — 120 characters at most.' };
  const identRaw = String(a.vehicleIdent ?? '').trim();
  const vehicle_ident = identRaw ? identRaw.slice(0, 40) : null;

  const inputs = normaliseInputs(a.inputs);
  // ONE COMPUTATION feeds both the JSON and the denormalised columns, so a list can never show a
  // profit the model itself would not produce.
  const result = computeModel(inputs);
  const data = {
    label, vehicle_ident,
    inputs: inputs as unknown as object,
    purchase_pence: inputs.purchasePence, sale_pence: inputs.salePence,
    vat_status: inputs.vatStatus, profit_pence: result.profitPence,
  };

  if (a.id) {
    // SCOPED UPDATE, not a read-then-write: the where clause carries the tenant, so another garage's
    // id updates nothing rather than being checked and then trusted.
    const { count } = await prisma.purchaseModel.updateMany({ where: { id: a.id, group_id: a.groupId }, data });
    if (count !== 1) return { refused: 'That model no longer exists.' };
    return { id: a.id };
  }
  const row = await prisma.purchaseModel.create({
    data: { ...data, group_id: a.groupId, created_by_user_id: a.userId, status: MODEL_STATUSES[0] },
    select: { id: true },
  });
  return { id: row.id };
}

/** The list: enough to choose from, never enough to mistake for an answer. */
export function listModels(groupId: string) {
  return prisma.purchaseModel.findMany({
    where: { group_id: groupId },
    orderBy: { updated_at: 'desc' },
    take: 100,
    select: { id: true, label: true, vehicle_ident: true, purchase_pence: true, sale_pence: true, vat_status: true, profit_pence: true, updated_at: true },
  });
}

export async function getModel(groupId: string, id: string) {
  const row = await prisma.purchaseModel.findFirst({
    where: { id, group_id: groupId },
    select: { id: true, label: true, vehicle_ident: true, inputs: true, status: true },
  });
  if (!row) return null;
  // RE-NORMALISED ON READ. A row saved before a slider's range moved must still open inside it —
  // otherwise the control renders at a value it cannot represent and the first drag jumps.
  return { ...row, inputs: normaliseInputs(row.inputs) };
}

export async function removeModel(groupId: string, id: string): Promise<boolean> {
  const { count } = await prisma.purchaseModel.deleteMany({ where: { id, group_id: groupId } });
  return count === 1;
}
