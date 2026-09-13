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
  SLIDERS, VAT_STATUSES, MODEL_STATUSES, clampSlider, computeModel, defaultInputs, type ModelInputs, type SliderKey, type VatStatus, SOURCES, SOURCE_RULES, availableVatStatuses, type PurchaseSource, type FundingPlan, hasFeeSlot,
} from '@/lib/purchase-model';

/** Whatever arrived over the wire, made safe: every slider clamped to its own definition. */
/**
 * ── AN ABSENT PLAN IS CASH, AND CASH IS WHAT SHIPPED ────────────────────────────────────────────
 * Every model saved before 2026-09-13 has no `funding` key at all. It reads back as `{ kind: 'cash' }`,
 * whose branch in fundingCost is the simple-interest line that was there before — so a stored answer
 * cannot move. purchase-model-gate asserts that equality directly rather than by reasoning about it.
 *
 * An unrecognised kind is cash for the same reason: normalising a document, not validating a form.
 * Nothing here invents a facility's terms — a missing number is zero, and a facility of zeroes costs
 * nothing and says so on screen, which is honest. A plausible default would not be.
 */
function normaliseFunding(raw: unknown): FundingPlan {
  const f = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown, cap: number) => {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? Math.min(cap, Math.max(0, x)) : 0;
  };
  if (f.kind === 'overdraft') {
    return { kind: 'overdraft', arrangementFeePence: Math.round(n(f.arrangementFeePence, 5000000)) };
  }
  if (f.kind === 'facility') {
    return {
      kind: 'facility',
      advancePct: n(f.advancePct, 100),
      monthlyPctOfAdvance: n(f.monthlyPctOfAdvance, 10),
      curtailPctPerMonth: n(f.curtailPctPerMonth, 100),
      graceDays: Math.round(n(f.graceDays, 180)),
      perUnitFeePence: Math.round(n(f.perUnitFeePence, 1000000)),
      termDays: Math.round(n(f.termDays, 730)),
    };
  }
  return { kind: 'cash' };
}

/**
 * A PRE-SPLIT MODEL'S `buyerFeePence`, PUT WHERE THAT SOURCE ALREADY TREATED IT.
 *
 * Auction rules folded the old single fee into the margin base with its VAT inside — that is a PREMIUM.
 * Trade rules treated it as a net standard-rated service — the SERVICES slot. Every other source had no
 * fee at all. Returns 0 for the slot the old value did not mean, so nothing is counted twice.
 */
function legacyFee(b: Record<string, unknown>, source: PurchaseSource, slot: 'premium' | 'services'): number {
  const old = typeof b.buyerFeePence === 'number' ? b.buyerFeePence : Number(b.buyerFeePence);
  if (!Number.isFinite(old) || old <= 0) return 0;
  if (source === 'auction') return slot === 'premium' ? old : 0;
  if (source === 'trade') return slot === 'services' ? old : 0;
  return 0;
}

export function normaliseInputs(raw: unknown): ModelInputs {
  const b = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const d = defaultInputs();
  // SOURCE FIRST: the fee and the VAT status are both read through it, so it has to be settled before
  // either. An unrecognised source is the default rather than a refusal — this normalises a document.
  const source: PurchaseSource = (SOURCES as readonly string[]).includes(String(b.source))
    ? (b.source as PurchaseSource) : d.source;
  const out: ModelInputs = {
    purchasePence: Math.max(0, Math.round(num(b.purchasePence, d.purchasePence))),
    salePence: Math.max(0, Math.round(num(b.salePence, d.salePence))),
    source,
    funding: normaliseFunding(b.funding),
    // ── A FEE IS ZERO WHERE THE INVOICE CANNOT CARRY IT ─────────────────────────────────────────
    // A private seller invoices no premium, so a figure arriving with source 'private' is a stale field
    // from a changed answer, not a cost. hasFeeSlot is the one reader of that rule.
    //
    // AND THE ONE-FIELD MODELS ARE CARRIED OVER FAITHFULLY. Until 2026-09-13 there was a single
    // `buyerFeePence` whose MEANING depended on the source: on an auction the rules folded it into the
    // margin base with its VAT inside (a premium), on a trade purchase they treated it as a net
    // standard-rated service. It migrates to whichever slot that source already applied to it, so no
    // stored answer moves. Mapping it to one slot for both would have changed every old auction model
    // by 20% of the fee, silently.
    premiumPence: hasFeeSlot(source, 'premium')
      ? Math.min(5000000, Math.max(0, Math.round(num(b.premiumPence, legacyFee(b, source, 'premium')))))
      : 0,
    servicesPence: hasFeeSlot(source, 'services')
      ? Math.min(5000000, Math.max(0, Math.round(num(b.servicesPence, legacyFee(b, source, 'services')))))
      : 0,
    // ── THE CONSTRAINT LIVES HERE, NOT ONLY IN THE FORM ─────────────────────────────────────────
    // A car bought privately cannot be VAT qualifying: there is no VAT invoice to reclaim against. The
    // page hides the toggle, but a hidden control is not a rule — this is the WRITER, and it is what
    // stops a hand-made POST, or a model saved before the source question existed, producing a £1,667
    // answer that cannot happen. Falls back to the source's FIRST permitted status, which is margin.
    vatStatus: availableVatStatuses(source).includes(String(b.vatStatus) as VatStatus)
      ? (b.vatStatus as VatStatus)
      : availableVatStatuses(source)[0],
    // DEFAULTS TO PLUS VAT (false): it preserves the behaviour that shipped and is the conservative
    // reading — it produces the lower profit. An absent field is therefore never the generous answer.
    purchaseIncludesVat: b.purchaseIncludesVat === true,
    // ABSENT MEANS ZERO, AND ZERO MEANS NO SENTENCE. A model saved before this field existed reads
    // back with no advertising contract, so the break-even line simply does not appear — it does not
    // appear with a made-up figure in it. Capped at £100k/month: above that it is a typo.
    adContractMonthlyPence: Math.min(10000000, Math.max(0, Math.round(num(b.adContractMonthlyPence, 0)))),
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
    // THE COLUMN IS `profit_pence` AND THE FIELD IS `contributionPence`, deliberately. The figure was
    // always a contribution — it counts nothing the business pays whether the car exists or not — and
    // the name was corrected on 2026-09-13. Renaming the COLUMN is a constraining migration for a
    // word, so the mismatch lives here, in the one line that crosses the boundary, rather than in a
    // reader's memory. Nothing else may read `profit_pence` and call it profit.
    vat_status: inputs.vatStatus, profit_pence: result.contributionPence,
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
