/**
 * File: lib/purchase-model.ts
 * BUYING A CAR: what is left after VAT, after money, and after the workshop's own time.
 * Pure, importing nothing — every figure below is provable without a database or a browser.
 *
 * ── EVERYTHING HERE IS AN ASSUMPTION, AND NONE OF IT IS MEASURED ────────────────────────────────
 * A slider is honest because the person just chose it. Nothing in this file reads a garage's own
 * data, and nothing it returns may be rendered as though it did. The defaults and ranges below are
 * STARTING POINTS so a garage that has never measured prep hours has somewhere to begin — they are
 * not benchmarks, not averages, and not derived from anybody's accounts.
 *
 * ── FREEZE-AT-ISSUE DOES NOT APPLY HERE, AND THAT IS DELIBERATE ─────────────────────────────────
 * An invoice freezes its lines at mint and a clock session's recorded time is never edited, both for
 * the same reason: they are RECORDS of something that happened. A purchase model is not a record. It
 * is a question somebody is still asking, and it is MEANT to be changed — dragging it again is the
 * entire point of the tool. So: no append-only trigger, no snapshot-on-save, no version chain. If a
 * later reader reaches for the invoice rule by analogy, this paragraph is the answer: the analogy is
 * wrong because the subject is different.
 *
 * ── WORKSHOP COST AND COST OF MONEY ARE SLIDERS IN v1 ───────────────────────────────────────────
 * Both should one day be DERIVED from the garage's own standing-still rate. They are not, and no
 * rate is invented here. The ingredients exist and are unassembled — lib/dashboard-tiles'
 * monthlyWageBill plus lib/costs' costsInWindow over lib/capacity's available hours — and the reason
 * not to assemble them yet is specific: the wage bill EXCLUDES hourly staff and names them
 * (hourlyExcludedPeople), so a rate derived today would be understated by exactly the people who
 * turn spanners. Clocking now supplies the missing hours; connecting them is its own decision.
 */

/**
 * WHERE A MODEL HAS GOT TO. Only one value today; the field exists so a later stock slice has room
 * for 'bought' and 'sold' without a constraining migration. Enforced HERE rather than by a database
 * CHECK, deliberately — see the note on the column: a CHECK would make using that room the very
 * two-push cycle the room was for.
 */
export const MODEL_STATUSES = ['modelled'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export const VAT_STATUSES = ['margin', 'qualifying'] as const;
export type VatStatus = (typeof VAT_STATUSES)[number];

/** The UK VAT fraction on a VAT-inclusive amount at 20%: 20/120. */
const VAT_FRACTION = 1 / 6;

/**
 * VAT THE GARAGE MUST ACCOUNT FOR ON THE SALE. A TOGGLE, never an assumption, because the two
 * answers are not close: £8,000 in and £10,000 out is £333 on the margin scheme and £1,667 if the
 * car is VAT qualifying. Guessing costs money on every car.
 *
 *   MARGIN SCHEME — VAT on the MARGIN only: (sale − purchase) × 1/6, and nothing when the car sells
 *   at or below what it cost. There is no VAT to reclaim on the purchase; that is the trade-off the
 *   scheme makes.
 *
 *   VAT QUALIFYING — VAT on the FULL sale price: sale × 1/6.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT MODEL ───────────────────────────────────────────────────────
 * Input-VAT RECOVERY on a qualifying purchase. A garage buying a qualifying car can usually reclaim
 * the VAT in the purchase price, which would net the two schemes much closer together. That is a
 * real effect and it is left out of v1 ON PURPOSE: netting it silently would change the number the
 * owner specified, and whether the typed purchase price is VAT-inclusive is a question the form does
 * not yet ask. Stated here rather than approximated — see the owner's note on the toggle.
 */
export function vatDuePence(purchasePence: number, salePence: number, status: VatStatus): number {
  if (status === 'qualifying') return Math.round(salePence * VAT_FRACTION);
  const margin = salePence - purchasePence;
  return margin > 0 ? Math.round(margin * VAT_FRACTION) : 0;   // no margin, no VAT
}

export type VatPosition = {
  /** Output VAT on the sale — what the scheme charges. */
  outputVatPence: number;
  /** Input VAT reclaimable on the purchase. Always 0 on the margin scheme. */
  inputVatPence: number;
  /** What actually goes to HMRC: output less input. */
  vatToHmrcPence: number;
  /** THE CASH THAT LEAVES THE BANK to buy the car — not the same as its cost. */
  cashOutPence: number;
  /** The purchase as a COST, after any VAT that comes back. */
  netCostPence: number;
};

/**
 * THE WHOLE VAT POSITION, and the reason it is four numbers rather than one.
 *
 * ── CASH OUT IS NOT COST, AND THIS TOOL IS ABOUT TIED-UP CAPITAL ────────────────────────────────
 * On a "plus VAT" purchase the garage pays purchase × 1.2 and gets the VAT back LATER. £9,600 leaves
 * the bank on an £8,000 car. A model about the cost of money that charges interest on £8,000 is
 * wrong about its own subject (owner, 2026-09-12), so cashOutPence is separate and the stocking cost
 * is charged on it.
 *
 * ── THE THREE ANSWERS, ON £8,000 IN AND £10,000 OUT ─────────────────────────────────────────────
 *   margin scheme                      → £333.33 to HMRC, £1,666.67 profit, £8,000 out
 *   qualifying, price INCLUDES VAT     → £333.33 to HMRC, £1,666.67 profit, £8,000 out
 *   qualifying, price PLUS VAT         →  £66.67 to HMRC,   £333.33 profit, £9,600 out
 *
 * The first two are IDENTICAL — the reclaim cancels the extra output VAT — which is exactly what the
 * shipped version got wrong when it said the toggle was worth £1,333.
 *
 * ── WHAT THIS ASSUMES, AND DOES NOT MODEL ───────────────────────────────────────────────────────
 * That the car is STOCK FOR RESALE. Input VAT on a car is blocked by default and recoverable by a
 * dealer under the stock-in-trade exception; using it as a courtesy car or demonstrator can taint
 * that. Not modelled — named on screen, and on the accountant list. Nor is the TIMING: the reclaim
 * arrives on the next return, so the VAT is out for up to about four months. Named, not modelled.
 */
export function vatPosition(purchasePence: number, salePence: number, status: VatStatus, purchaseIncludesVat: boolean): VatPosition {
  if (status === 'margin') {
    const outputVat = vatDuePence(purchasePence, salePence, 'margin');
    // NOTHING IS RECLAIMABLE on the margin scheme; the typed price is simply what you paid.
    return { outputVatPence: outputVat, inputVatPence: 0, vatToHmrcPence: outputVat, cashOutPence: purchasePence, netCostPence: purchasePence };
  }
  const outputVat = Math.round(salePence * VAT_FRACTION);
  const inputVat = purchaseIncludesVat ? Math.round(purchasePence * VAT_FRACTION) : Math.round(purchasePence * 0.2);
  const cashOut = purchaseIncludesVat ? purchasePence : purchasePence + inputVat;
  return {
    outputVatPence: outputVat, inputVatPence: inputVat,
    vatToHmrcPence: outputVat - inputVat,
    cashOutPence: cashOut,
    netCostPence: cashOut - inputVat,
  };
}

/** A slider: what it is, where it starts, and what counts as a plausible span for it. */
export type SliderDef = {
  key: SliderKey; label: string; unit: 'money' | 'hours' | 'days' | 'percent';
  min: number; max: number; step: number; def: number;
  /** Said on screen beside the control, because a range with no reason is another invented number. */
  note: string;
};
export type SliderKey =
  | 'prepHours' | 'partsPence' | 'daysInStock' | 'advertisingPence' | 'warrantyPence'
  | 'deliveryInPence' | 'deliveryOutPence' | 'workshopCostPerHourPence' | 'costOfMoneyAnnualPct';

/**
 * THE SLIDERS. Money is in PENCE throughout — one unit, no conversions hiding in components.
 *
 * The ranges are wide on purpose. A range that brackets the answer too tightly tells a garage what
 * to think; a wide one lets them find their own edge and see the profit move while they do. Each
 * carries a note saying what it covers, because "advertising £0–£300" without "per car, all
 * platforms" is a number pretending to be a definition.
 */
export const SLIDERS: SliderDef[] = [
  { key: 'prepHours', label: 'Prep hours', unit: 'hours', min: 0, max: 20, step: 0.5, def: 4,
    note: 'Workshop time before it goes on sale — valet, MOT, service, the small jobs.' },
  { key: 'partsPence', label: 'Parts', unit: 'money', min: 0, max: 200000, step: 2500, def: 25000,
    note: 'Parts and consumables fitted during prep, at cost.' },
  { key: 'daysInStock', label: 'Days in stock', unit: 'days', min: 0, max: 180, step: 5, def: 45,
    note: 'Bought to sold. This is what the cost of money is charged over.' },
  { key: 'advertisingPence', label: 'Advertising', unit: 'money', min: 0, max: 30000, step: 500, def: 6000,
    note: 'Per car, across every platform it is listed on.' },
  { key: 'warrantyPence', label: 'Warranty', unit: 'money', min: 0, max: 100000, step: 2500, def: 15000,
    note: 'What you expect this car to cost you after it leaves — provision, not a policy price.' },
  { key: 'deliveryInPence', label: 'Delivery in', unit: 'money', min: 0, max: 50000, step: 1000, def: 12000,
    note: 'Getting it from the auction or the seller to you.' },
  { key: 'deliveryOutPence', label: 'Delivery out', unit: 'money', min: 0, max: 50000, step: 1000, def: 0,
    note: 'Getting it to the buyer, if you are paying for that.' },
  { key: 'workshopCostPerHourPence', label: 'Workshop cost per hour', unit: 'money', min: 2000, max: 9000, step: 250, def: 4500,
    note: 'What an hour in your workshop COSTS you — not what you charge. A slider until the standing-still rate exists.' },
  { key: 'costOfMoneyAnnualPct', label: 'Cost of money', unit: 'percent', min: 0, max: 20, step: 0.5, def: 9,
    note: 'Annual rate on the money tied up in the car — stocking finance, an overdraft, or what the cash would otherwise earn.' },
];

export type ModelInputs = {
  purchasePence: number; salePence: number; vatStatus: VatStatus;
  /**
   * DOES THE TYPED PURCHASE PRICE INCLUDE VAT? Only meaningful when the car is VAT qualifying — on
   * the margin scheme nothing is recoverable and the typed figure is simply what you paid.
   *
   * It exists because the first version silently assumed one answer. `sale − purchase − sale/6`
   * rearranges to `sale_net − purchase`, which is profit when the typed figure is the NET price —
   * the trade convention of quoting qualifying cars "plus VAT". Correct for that reading, and
   * understated by £1,333 on an £8,000 car when the garage typed a VAT-INCLUSIVE price. Neither
   * reading announced itself, which was the whole defect.
   *
   * FALSE (plus VAT) is the default: it preserves the behaviour that shipped, and it is the
   * conservative direction — it produces the lower profit.
   */
  purchaseIncludesVat: boolean;
} & Record<SliderKey, number>;

/** Every slider at its default, so a fresh model opens on something rather than on zeroes. */
export function defaultInputs(): ModelInputs {
  const sliders = Object.fromEntries(SLIDERS.map((s) => [s.key, s.def])) as Record<SliderKey, number>;
  return { purchasePence: 800000, salePence: 1000000, vatStatus: 'margin', purchaseIncludesVat: false, ...sliders };
}

export type ModelResult = {
  vat: VatPosition;
  vatDuePence: number;
  workshopCostPence: number;
  stockingCostPence: number;
  otherCostsPence: number;
  totalCostsPence: number;
  profitPence: number;
  /** Profit before the two costs a garage rarely counts, so the tool can show what they take out. */
  profitBeforeWorkshopAndMoneyPence: number;
};

/**
 * THE MODEL. Kept as one pure function so the sensitivity below can call it a few hundred times on
 * every drag without touching anything but arithmetic.
 *
 * Stocking cost is simple interest over the days held: purchase × rate × days ÷ 365. Not a
 * distribution across reporting periods — lib/costs' spread/falls machinery answers a different
 * question, about real dated costs landing in real months, and this model owns no such thing.
 */
export function computeModel(i: ModelInputs): ModelResult {
  const vat = vatPosition(i.purchasePence, i.salePence, i.vatStatus, i.purchaseIncludesVat);
  const workshop = Math.round(i.prepHours * i.workshopCostPerHourPence);
  // ON THE CASH, NOT THE COST. The VAT on a plus-VAT purchase is out of the bank until the next
  // return; interest is paid on money that has gone, not on money that will come back.
  const stocking = Math.round(vat.cashOutPence * (i.costOfMoneyAnnualPct / 100) * (i.daysInStock / 365));
  const other = i.partsPence + i.advertisingPence + i.warrantyPence + i.deliveryInPence + i.deliveryOutPence;
  const total = workshop + stocking + other;
  // Revenue net of the VAT charged on the sale, less what the car actually cost after any reclaim.
  const gross = i.salePence - vat.outputVatPence - vat.netCostPence;
  return {
    vat, vatDuePence: vat.vatToHmrcPence,
    workshopCostPence: workshop, stockingCostPence: stocking,
    otherCostsPence: other, totalCostsPence: total,
    profitPence: gross - total,
    profitBeforeWorkshopAndMoneyPence: gross - other,
  };
}

export type Sensitivity = { key: SliderKey; label: string; swingPence: number };

/**
 * WHICH INPUT MOVES THE ANSWER MOST — and what that claim is limited to.
 *
 * LOCAL sensitivity: each slider is swung across its OWN plausible range with every other input held
 * exactly where the person has it, and the inputs are ranked by how far profit moves. Re-ranked on
 * every drag, because holding the others is what makes it local — change one and the ranking can
 * legitimately change.
 *
 * ── THE LIMIT IS THE POINT (owner, 2026-09-12) ──────────────────────────────────────────────────
 * This ranks THIS MODEL'S INPUTS UNDER THESE ASSUMPTIONS. It is NOT a claim about the garage's
 * business, and the screen must say so. The risk is higher here than for a slider: a slider looks
 * like a choice somebody made, while a ranking READS AS ANALYSIS — it arrives sorted, which is the
 * shape of a finding. Nothing in it was measured.
 */
export function sensitivity(i: ModelInputs): Sensitivity[] {
  const rows = SLIDERS.map((s) => {
    const low = computeModel({ ...i, [s.key]: s.min }).profitPence;
    const high = computeModel({ ...i, [s.key]: s.max }).profitPence;
    return { key: s.key, label: s.label, swingPence: Math.abs(high - low) };
  });
  // Descending by swing; ties by the slider's own order, so the list never jitters between equal rows.
  return rows.sort((a, b) => b.swingPence - a.swingPence
    || SLIDERS.findIndex((s) => s.key === a.key) - SLIDERS.findIndex((s) => s.key === b.key));
}

/** Clamp a slider to its own definition. The form is the prompt; this is the rule. */
export function clampSlider(key: SliderKey, value: number): number {
  const s = SLIDERS.find((x) => x.key === key);
  if (!s) return value;
  if (!Number.isFinite(value)) return s.def;
  return Math.min(s.max, Math.max(s.min, value));
}
