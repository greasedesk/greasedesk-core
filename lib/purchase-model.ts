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

export const SOURCES = ['auction', 'trade', 'private', 'part_exchange'] as const;
export type PurchaseSource = (typeof SOURCES)[number];

/**
 * ── WHERE THE CAR CAME FROM, AND WHY IT IS A QUESTION RATHER THAN A SLIDER ───────────────────────
 * A buyer's fee is not a cost line. At auction the auctioneer invoices the hammer price and the
 * buyer's premium as the price of the GOODS, so on a margin car the fee raises the purchase price the
 * margin is measured from — and a £300 fee therefore costs £250, because the margin falls by £300 and
 * the VAT on it by £50. Bought from another dealer, the same £300 "admin fee" is a separate
 * standard-rated SERVICE: it never touches the margin and it is a flat cost.
 *
 * Same money typed, two answers £50 apart. A "Fees" slider would add it to other costs and be wrong
 * in both directions at once — which is why the missing thing was a QUESTION, not a control.
 *
 * ── AND THE INVARIANT, WHICH IS THE WHOLE THING ─────────────────────────────────────────────────
 * A fee is EITHER inside the margin base OR reclaimable. NEVER BOTH. Counting it twice is the
 * failure mode this table exists to prevent, and purchase-model-gate asserts it for every source
 * rather than trusting the rows below to stay consistent.
 *
 * ── SOURCE ALSO DECIDES WHAT THE VAT TOGGLE MAY SAY ─────────────────────────────────────────────
 * A car bought privately cannot be VAT qualifying: there is no VAT invoice to reclaim against. Nor
 * can one taken in part-exchange from a private customer. Before this, the toggle was free, so
 * "private" plus "qualifying" produced a £1,667 answer that cannot happen — a wrong answer reachable
 * in two clicks, and worse than the missing fee.
 *
 * WHAT THIS DOES NOT CLAIM: whether a particular auction invoice is drawn under the Auctioneers'
 * Scheme, or whether a given dealer's fee carries VAT. Those belong to the garage's accountant; what
 * is modelled here is the SHAPE each answer implies, and the source is the person's own statement.
 */
export type SourceRule = {
  label: string;
  /** Does a buyer's fee form part of the price the MARGIN is measured from? */
  feeInMarginBase: boolean;
  /** What becomes of VAT on the fee itself. `in_goods_price` = inside the purchase, nothing separate. */
  feeVat: 'in_goods_price' | 'reclaimable' | 'none';
  /** Whether this source can produce a fee at all — private sellers do not invoice one. */
  hasFee: boolean;
  /** The VAT treatments this source can actually produce. */
  vatStatuses: readonly VatStatus[];
  note: string;
};

export const SOURCE_RULES: Record<PurchaseSource, SourceRule> = {
  auction: {
    label: 'Auction', feeInMarginBase: true, feeVat: 'in_goods_price', hasFee: true,
    vatStatuses: VAT_STATUSES,
    note: 'The buyer’s fee is invoiced as part of the price of the car, so on a margin car it raises the figure your margin is measured from — and costs you less than it looks.',
  },
  trade: {
    label: 'Another dealer', feeInMarginBase: false, feeVat: 'reclaimable', hasFee: true,
    vatStatuses: VAT_STATUSES,
    note: 'An admin or delivery fee from a dealer is a separate service, not part of the car’s price. It never changes your margin; it is a straight cost.',
  },
  private: {
    label: 'Private seller', feeInMarginBase: false, feeVat: 'none', hasFee: false,
    vatStatuses: ['margin'],
    note: 'No fee and no VAT invoice, so there is nothing to reclaim — this car can only be sold on the margin scheme.',
  },
  part_exchange: {
    label: 'Part-exchange', feeInMarginBase: false, feeVat: 'none', hasFee: false,
    vatStatuses: ['margin'],
    note: 'The purchase price IS the allowance you gave against the other car. No fee, no VAT invoice, margin scheme only.',
  },
};

/** What the toggle may offer for this source. One reader, so the page and the writer cannot disagree. */
export function availableVatStatuses(source: PurchaseSource): readonly VatStatus[] {
  return SOURCE_RULES[source].vatStatuses;
}

export type FeePosition = {
  /** Added to the price the margin is measured from. Zero unless the source folds it in. */
  inMarginBasePence: number;
  /** What the fee takes out of the bank, VAT on the fee included. */
  cashOutPence: number;
  /** VAT on the fee that comes back. Zero unless the source makes it separately reclaimable. */
  reclaimablePence: number;
  /** The fee as a COST, after anything reclaimed. */
  netCostPence: number;
};

/**
 * THE FEE, BY SOURCE. Four numbers for the same reason the VAT position is four: what leaves the
 * bank, what comes back, what it costs, and what it does to the margin are different questions.
 *
 * `vatRegistered` is passed in rather than stored. It is the TENANT's registration, read from the tax
 * profile on every render — persisting it into a saved model's inputs would freeze a fact about the
 * business inside a document about a car, and it would be wrong the day they registered.
 */
export function feePosition(
  source: PurchaseSource, feePence: number, vatRegistered: boolean,
): FeePosition {
  const rule = SOURCE_RULES[source];
  const fee = rule.hasFee ? Math.max(0, Math.round(feePence)) : 0;
  if (fee === 0) return { inMarginBasePence: 0, cashOutPence: 0, reclaimablePence: 0, netCostPence: 0 };

  if (rule.feeInMarginBase) {
    // IN THE GOODS PRICE. The relief comes through the margin, so there is nothing to reclaim — and
    // claiming both would be the double count the invariant forbids.
    return { inMarginBasePence: fee, cashOutPence: fee, reclaimablePence: 0, netCostPence: fee };
  }
  if (rule.feeVat === 'reclaimable') {
    // A SERVICE, STANDARD RATED ON TOP. The typed fee is the net amount — that is how a dealer quotes
    // an admin fee — so VAT is added to what leaves the bank and comes back only if registered.
    const vat = Math.round(fee * 0.2);
    return {
      inMarginBasePence: 0,
      cashOutPence: fee + vat,
      reclaimablePence: vatRegistered ? vat : 0,
      netCostPence: fee + (vatRegistered ? 0 : vat),
    };
  }
  return { inMarginBasePence: 0, cashOutPence: fee, reclaimablePence: 0, netCostPence: fee };
}

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
 * ── THIS FUNCTION ANSWERS ONLY THE OUTPUT SIDE ──────────────────────────────────────────────────
 * Input-VAT RECOVERY is NOT here. It was absent from v1 altogether; it is now modelled, one level
 * up, in vatPosition() — which is why the two read so differently on a qualifying car. Call this one
 * only when you want the VAT CHARGED ON THE SALE; call vatPosition() for what reaches HMRC, what
 * leaves the bank, and what the car ends up costing. Returning output VAT from a function named for
 * what is "due" is the narrow reading, and naming it here is what stops the wrong one being used.
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
export function vatPosition(
  purchasePence: number, salePence: number, status: VatStatus, purchaseIncludesVat: boolean,
  /**
   * THE PRICE THE MARGIN IS MEASURED FROM, when it is not simply what you paid for the car — an
   * auction's buyer fee is invoiced as part of the goods. DEFAULTS TO purchasePence, so every caller
   * that predates the source question gets the identical answer it got before; purchase-model-gate
   * asserts that equality rather than leaving it to be assumed.
   */
  marginBasePence: number = purchasePence,
): VatPosition {
  if (status === 'margin') {
    const outputVat = vatDuePence(marginBasePence, salePence, 'margin');
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
    // WAS: "Per car, across every platform it is listed on." It cannot be: the platforms are a MONTHLY
    // CONTRACT, and no per-car figure for a fixed cost has a denominator this page knows. The note now
    // describes only what genuinely varies by car, and the contract has its own field above.
    note: 'Per car only — photography, a paid boost on one listing. Your monthly platform contract is not this.' },
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
   * THE MONTHLY ADVERTISING CONTRACT, AND IT IS NEVER DIVIDED INTO A CAR. Autotrader is about £1,500
   * a month for ten cars and £5,000+ for a bigger dealer — a fixed overhead, not a per-car cost.
   * Dividing it gives £150 a car at ten sales and £300 at five, so a per-car advertising figure asks
   * the user for a number that depends on turnover, which is partly what this model exists to work
   * out. The same circularity as the workshop rate.
   *
   * So it is NOT a cost here and nothing adds it to one. It drives ONE derived sentence — how many
   * sales a month this contribution would have to cover it — which turns the circularity into an
   * output instead of hiding it in an input.
   *
   * DEFAULT ZERO. £1,500 is the owner's own quote, not a typical figure, and shipping it as a default
   * would state one dealer's contract as a fact about every garage.
   */
  adContractMonthlyPence: number;
  /** WHERE IT CAME FROM. Decides what a fee does, and what the VAT toggle is allowed to say. */
  source: PurchaseSource;
  /**
   * THE BUYER'S FEE — the auction's premium, or a dealer's admin fee. Typed NET: that is how both are
   * quoted. What it does to the answer is SOURCE_RULES' business, not this field's.
   */
  buyerFeePence: number;
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
  return { purchasePence: 800000, salePence: 1000000, vatStatus: 'margin', purchaseIncludesVat: false, adContractMonthlyPence: 0, source: 'auction', buyerFeePence: 0, ...sliders };
}

/**
 * ── IT IS A CONTRIBUTION, NOT A PROFIT (owner, 2026-09-13) ──────────────────────────────────────
 * This model counts what the CAR costs. It counts nothing the business pays whether or not the car
 * exists: the Autotrader contract, rent, insurance, the phone bill. A figure that excludes every
 * fixed cost is a CONTRIBUTION — what this car adds before the standing costs — and calling it
 * profit invites exactly the misreading the swing column was fixed for a day earlier.
 *
 * The field was `profitPence` and the screen said "Profit" in 24px bold. The database column is
 * still `profit_pence`: renaming it is a constraining migration for a word, and the store maps it
 * (lib/purchase-model-store) with the mismatch stated there rather than left to be rediscovered.
 */
export type ModelResult = {
  vat: VatPosition;
  /** What the buyer's fee did — to the bank, to the margin, and to the cost. */
  fee: FeePosition;
  vatDuePence: number;
  workshopCostPence: number;
  stockingCostPence: number;
  otherCostsPence: number;
  totalCostsPence: number;
  contributionPence: number;
  /** Profit before the two costs a garage rarely counts, so the tool can show what they take out. */
  contributionBeforeWorkshopAndMoneyPence: number;
};

/**
 * THE MODEL. Kept as one pure function so the sensitivity below can call it a few hundred times on
 * every drag without touching anything but arithmetic.
 *
 * Stocking cost is simple interest over the days held: purchase × rate × days ÷ 365. Not a
 * distribution across reporting periods — lib/costs' spread/falls machinery answers a different
 * question, about real dated costs landing in real months, and this model owns no such thing.
 */
export function computeModel(i: ModelInputs, opts: { vatRegistered?: boolean } = {}): ModelResult {
  // THE FEE FIRST, because on a margin car it changes the figure the VAT is worked out from. A fee
  // added afterwards as a cost would give the right total and the wrong VAT, which is the error this
  // whole slice exists to prevent.
  const fee = feePosition(i.source, i.buyerFeePence, opts.vatRegistered === true);
  const vat = vatPosition(i.purchasePence, i.salePence, i.vatStatus, i.purchaseIncludesVat,
    i.purchasePence + fee.inMarginBasePence);
  const workshop = Math.round(i.prepHours * i.workshopCostPerHourPence);
  // ON THE CASH, NOT THE COST. The VAT on a plus-VAT purchase is out of the bank until the next
  // return; interest is paid on money that has gone, not on money that will come back.
  // ON THE CASH, FEE INCLUDED. The fee leaves the bank with the car and is tied up just as long.
  const cashOut = vat.cashOutPence + fee.cashOutPence;
  const stocking = Math.round(cashOut * (i.costOfMoneyAnnualPct / 100) * (i.daysInStock / 365));
  const other = i.partsPence + i.advertisingPence + i.warrantyPence + i.deliveryInPence + i.deliveryOutPence;
  const total = workshop + stocking + other;
  // Revenue net of the VAT charged on the sale, less what the car and the fee actually cost after any
  // reclaim. The fee's VAT is netted HERE when the source makes it separately reclaimable; when the
  // source folds the fee into the goods price it is already relieved through the margin above, and
  // counting it in both places is exactly what the invariant forbids.
  const gross = i.salePence - vat.outputVatPence - vat.netCostPence - fee.netCostPence;
  return {
    vat, fee, vatDuePence: vat.vatToHmrcPence,
    workshopCostPence: workshop, stockingCostPence: stocking,
    otherCostsPence: other, totalCostsPence: total,
    contributionPence: gross - total,
    contributionBeforeWorkshopAndMoneyPence: gross - other,
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
export function sensitivity(i: ModelInputs, opts: { vatRegistered?: boolean } = {}): Sensitivity[] {
  const rows = SLIDERS.map((s) => {
    // THE SAME OPTIONS AS THE ANSWER. A ranking computed against a different model from the figure
    // above it would be a list of swings in a world the person is not looking at.
    const low = computeModel({ ...i, [s.key]: s.min }, opts).contributionPence;
    const high = computeModel({ ...i, [s.key]: s.max }, opts).contributionPence;
    return { key: s.key, label: s.label, swingPence: Math.abs(high - low) };
  });
  // Descending by swing; ties by the slider's own order, so the list never jitters between equal rows.
  return rows.sort((a, b) => b.swingPence - a.swingPence
    || SLIDERS.findIndex((s) => s.key === a.key) - SLIDERS.findIndex((s) => s.key === b.key));
}

/**
 * HOW MANY SALES A MONTH COVER A FIXED MONTHLY COST, at this contribution per car.
 *
 * The honest direction for the question. "What does advertising cost per car?" cannot be answered
 * without knowing how many cars sell, which is the thing being worked out; "how many sales would
 * cover £1,500?" can be answered from one car's contribution, and the person already knows whether
 * that number is reachable.
 *
 * NULL, not zero and not Infinity, in the three cases where there is no answer: no contract to
 * cover, and a contribution of zero or less — no quantity of a car that loses money covers anything,
 * and a rounded-up division would print a confident figure for an impossible question.
 */
export function salesToCoverMonthly(contributionPence: number, monthlyFixedPence: number): number | null {
  if (monthlyFixedPence <= 0) return null;
  if (contributionPence <= 0) return null;
  return Math.ceil(monthlyFixedPence / contributionPence);
}

/** Clamp a slider to its own definition. The form is the prompt; this is the rule. */
export function clampSlider(key: SliderKey, value: number): number {
  const s = SLIDERS.find((x) => x.key === key);
  if (!s) return value;
  if (!Number.isFinite(value)) return s.def;
  return Math.min(s.max, Math.max(s.min, value));
}
