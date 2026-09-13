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
  SLIDERS, VAT_STATUSES, MODEL_STATUSES, clampSlider, computeModel, defaultInputs, type ModelInputs, type SliderKey, type VatStatus, SOURCES, SOURCE_RULES, availableVatStatuses, type PurchaseSource, type FundingPlan, hasFeeSlot, FLAGGED_COSTS, VAT_TREATMENTS, defaultCostVat, type FlaggedCost, type VatTreatment,
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

/**
 * A SERVICES FIGURE TYPED BEFORE THE CONVENTION CHANGED. Net becomes gross by adding the VAT that was
 * previously worked out on top of it, so the ANSWER a stored model gives is identical either side of
 * the change — the number in the box moves, nothing it produces does. Idempotent: a document already
 * stamped `gross` is returned untouched, so re-reading cannot inflate it by 20% a second time.
 *
 * There are no such documents today (zero PurchaseModel rows exist at the time of writing), so this
 * protects nothing yet. The page is live and a save is one click away, which is the whole reason it is
 * here rather than in a note saying it would be easy to add.
 */
function toGross(value: number, basis: unknown): number {
  if (basis === 'gross') return value;
  return Math.round(value * 1.2);
}

/** One treatment per flagged cost, defaulting per defaultCostVat and ignoring anything unrecognised. */
function normaliseCostVat(raw: unknown): Record<FlaggedCost, VatTreatment> {
  const given = (raw ?? {}) as Record<string, unknown>;
  const out = defaultCostVat();
  for (const k of FLAGGED_COSTS) {
    if ((VAT_TREATMENTS as readonly string[]).includes(String(given[k]))) out[k] = given[k] as VatTreatment;
  }
  return out;
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
    // ── ABSENT IS THE DEFAULT, AND THE DEFAULT IS TODAY'S ARITHMETIC ────────────────────────────
    // A document written before suppliers could be flagged has no map at all, and the defaults make
    // every cost equal to what was paid — which is exactly what that document meant when it was saved.
    // An unrecognised treatment falls back the same way rather than throwing: this normalises a
    // document, it does not validate a form.
    costVat: normaliseCostVat(b.costVat),
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
    // ── AND THE BASIS IT WAS TYPED ON ───────────────────────────────────────────────────────────
    // This field asked for the NET figure until 2026-09-13, when every money field became gross. The
    // two are indistinguishable as numbers — £68 net and £68 gross are both "68" — so the document has
    // to SAY which, and a document that does not say is old and therefore net.
    servicesPence: hasFeeSlot(source, 'services')
      ? Math.min(5000000, Math.max(0, Math.round(
          toGross(num(b.servicesPence, legacyFee(b, source, 'services')), b.feeEntryBasis))))
      : 0,
    // Stamped on every save from now on. Its ABSENCE is the migration signal, so it is never omitted.
    feeEntryBasis: 'gross',
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
    // ABSENT MEANS ZERO, AND ZERO MEANS NO SENTENCE. A model saved before this field existed reads back
    // with no subscription, so the break-even line simply does not appear — it does not appear with a
    // made-up figure in it. Capped at £100k/month: above that it is a typo.
    //
    // THE OLD KEY IS STILL READ. It was `adContractMonthlyPence` for a few hours on 2026-09-13 before
    // the field became the named Autotrader line; a model saved in that window holds the same number
    // under the old name, and dropping it would quietly zero somebody's subscription.
    autotraderMonthlyPence: Math.min(10000000, Math.max(0, Math.round(
      num(b.autotraderMonthlyPence, num(b.adContractMonthlyPence, 0))))),
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
    // ── THE ONE PLACE THE NAMES DIFFER, AND IT IS STATED RATHER THAN REMEMBERED ─────────────────
    // COLUMN `profit_pence`, FIELD `grossProfitPence`, SCREEN "Gross profit on this car". The field and
    // the screen agree deliberately; only the column lags, because renaming it is a constraining
    // migration for a word. This line is the whole boundary — nothing else in the codebase reads
    // `profit_pence`, and nothing may read it and call it profit without that qualification.
    //
    // The number has been called three things: profitPence, then grossProfitPence, now grossProfitPence.
    // Two are GONE rather than layered — three unstated names for one number is what this avoids.
    vat_status: inputs.vatStatus, profit_pence: result.grossProfitPence,
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
