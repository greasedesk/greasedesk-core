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

/**
 * ── ONE CONVENTION FOR EVERY MONEY FIELD: WHAT LEAVES THE BANK ──────────────────────────────────
 * Every amount typed into this model is the GROSS figure — the total paid, VAT included. It is the
 * number on the document in front of the person, it needs no arithmetic at entry, and for a supplier
 * who is not VAT registered it is the same number either way.
 *
 * The alternative was to let each field follow its own document's convention, which is how the page
 * came to mix the two: the indemnities asked for NET while five sliders said nothing at all and were
 * silently treated as final cost. A page mixing net and gross is wrong by a fifth in places nobody can
 * see, and the error is invisible precisely because both readings look like a plausible amount.
 *
 * ── WHAT "STATES ITS BASIS" MEANS ───────────────────────────────────────────────────────────────
 * Not that every field says "gross". A field may state its basis by ASKING — the purchase price does,
 * because the trade genuinely quotes qualifying cars "plus VAT" and the answer is recorded rather than
 * assumed. What is forbidden is a money field that leaves the reader to infer.
 */
export const GROSS_BASIS_NOTE = 'Type the total you pay, VAT included.';

/**
 * WHAT THE SALE FIGURE IS, and it was never said. `outputVat = sale × 1/6` EXTRACTS VAT from a
 * VAT-inclusive amount, so this field has always been gross by construction — and the label said
 * nothing. A garage typing an ex-VAT sale price on a qualifying car understates the VAT it owes by a
 * sixth OF THE WHOLE SALE PRICE: £1,667 on a £10,000 car, an order of magnitude past any cost slider.
 */
export const SALE_BASIS_NOTE = 'What the customer pays, VAT included.';

export const SOURCES = ['auction', 'trade', 'private', 'part_exchange', 'return', 'buyback'] as const;
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
/**
 * ── TWO FEES ON ONE INVOICE, AND THEY ARE DIFFERENT MECHANISMS ──────────────────────────────────
 * A Manheim or BCA invoice carries both, and treating them as one amount is wrong in both directions:
 *
 *   BUYER'S PREMIUM — VAT is INSIDE it and is not shown separately (HMRC VAT Notice 718/1, and the
 *   invoice states it on its face). It forms part of the price of the goods, so it goes INTO the figure
 *   the margin is measured from, and NOTHING is reclaimable from it. The garage types £265.20 exactly
 *   as printed: this model neither adds VAT to that figure nor recovers any from it.
 *
 *   INDEMNITIES — Simulcast, SureCheck and the like. Standard rated with the VAT shown SEPARATELY,
 *   reclaimable if registered, and never part of the margin base. The garage types the TOTAL INCLUDING
 *   VAT — the same convention as every other money field — and the model takes the VAT back out.
 *
 * Both fees are therefore typed the same way, as the total paid, and differ ONLY in relief route:
 * the premium through the margin, the indemnities through recovery. Which is the invariant, restated
 * as a data-entry rule.
 *
 * A dealer's admin fee is mechanically the same as an indemnity — a separate standard-rated service —
 * so it uses the same slot under its own label. The LABELS are the words on the invoice, deliberately:
 * "buyer's premium" and "indemnities" are what the garage is reading off the page in front of them.
 *
 * ── THE INVARIANT, NOW ACROSS TWO FEE TYPES ─────────────────────────────────────────────────────
 * A fee is either in the margin base OR reclaimable. Never both, and NEVER NEITHER — each type has
 * exactly one relief route, and a type with no route is a fee quietly costing more than it should.
 * Asserted per source per slot, with the garage registered, because that is the case in which both
 * routes are available and a missing one cannot hide behind "not registered".
 */
export type FeeSlot = 'premium' | 'services';

export type SourceFee = { slot: FeeSlot; /** The invoice's own word for it. */ label: string; note: string };

export type SourceRule = {
  label: string;
  /** Which fees this source's invoice can carry, in the order they appear on it. */
  fees: SourceFee[];
  /** The VAT treatments this source can actually produce. */
  vatStatuses: readonly VatStatus[];
  note: string;
};

export const SOURCE_RULES: Record<PurchaseSource, SourceRule> = {
  auction: {
    label: 'Auction',
    vatStatuses: VAT_STATUSES,
    fees: [
      { slot: 'premium', label: 'Buyer’s premium',
        note: 'VAT is inside this figure and not shown separately, so type it exactly as the invoice has it. It forms part of the car’s price, so your margin is measured from it — and nothing is reclaimable from it.' },
      { slot: 'services', label: 'Indemnities',
        note: 'Simulcast, SureCheck and the like — standard rated. Type the total including VAT, as with everything else; the VAT is reclaimable and it never touches your margin.' },
    ],
    note: 'The buyer’s premium is invoiced as part of the price of the car; the indemnities are separate services. They behave differently, so they are asked for separately.',
  },
  trade: {
    label: 'Another dealer',
    vatStatuses: VAT_STATUSES,
    fees: [
      { slot: 'services', label: 'Admin or delivery fee',
        note: 'A separate standard-rated service. Type the total including VAT — the VAT is reclaimable and it never changes your margin.' },
    ],
    note: 'An admin or delivery fee from a dealer is a separate service, not part of the car’s price. It never changes your margin; it is a straight cost.',
  },
  private: {
    label: 'Private seller', fees: [], vatStatuses: ['margin'],
    note: 'No fee and no VAT invoice, so there is nothing to reclaim — this car can only be sold on the margin scheme.',
  },
  part_exchange: {
    label: 'Part-exchange', fees: [], vatStatuses: ['margin'],
    note: 'The purchase price IS the allowance you gave against the other car. No fee, no VAT invoice, margin scheme only.',
  },

  /**
   * ── TWO WAYS A CAR YOU SOLD COMES BACK, AND THEY ARE NOT THE SAME TRANSACTION ─────────────────
   *
   * They are separate sources because they have separate VAT consequences, and because NOTHING can
   * tell them apart by looking. Finding an old invoice for the registration is true of both — so the
   * match may show what it found and must never choose. See lib/stock-reacquisition.
   */
  return: {
    label: 'Return — the sale is being reversed', fees: [], vatStatuses: VAT_STATUSES,
    note: 'The sale did not stand: the car comes back and the customer is credited. Its original purchase price and VAT status are restored, because that cost base never stopped being yours. A credit note reverses the output VAT you declared on the sale.',
  },
  buyback: {
    label: 'Buyback — you bought it back', fees: [], vatStatuses: VAT_STATUSES,
    note: 'The original sale stands. This is a fresh purchase at what you have just paid, and the margin on the next sale is measured from that — not from what the car cost you the first time. No credit note: the VAT on the original sale was correctly due.',
  },
};

/** Does this source's invoice carry that fee? One reader, so the form and the writer cannot disagree. */
export function hasFeeSlot(source: PurchaseSource, slot: FeeSlot): boolean {
  return SOURCE_RULES[source].fees.some((f) => f.slot === slot);
}

/** What the toggle may offer for this source. One reader, so the page and the writer cannot disagree. */
export function availableVatStatuses(source: PurchaseSource): readonly VatStatus[] {
  return SOURCE_RULES[source].vatStatuses;
}

export type FeePosition = {
  /** The buyer's premium, VAT-inclusive, exactly as typed. Zero where the invoice carries none. */
  premiumPence: number;
  /** Standard-rated services, NET, as typed. */
  servicesPence: number;
  /** VAT on those services — worked out here, because the invoice shows it separately. */
  servicesVatPence: number;
  /** Added to the price the margin is measured from. The premium, and only the premium. */
  inMarginBasePence: number;
  /** What the fees take out of the bank, the services' VAT included. */
  cashOutPence: number;
  /** VAT that comes back: the services' VAT, and only when registered. */
  reclaimablePence: number;
  /** The fees as a COST, after anything reclaimed. */
  netCostPence: number;
};

/**
 * THE FEES, BY SOURCE. Seven numbers rather than one because the two mechanisms differ in every respect
 * that matters: where the VAT is, whether it comes back, and whether the margin moves.
 *
 * `vatRegistered` is passed in rather than stored. It is the TENANT's registration, read from the tax
 * profile on every render — persisting it into a saved model would freeze a fact about the business
 * inside a document about a car, and it would be wrong the day they registered.
 */
/**
 * WHAT A FEE ADDS TO THE PRICE THE MARGIN IS MEASURED FROM. The buyer's premium, and only the premium —
 * HMRC Notice 718/1 treats it as part of the price of the goods, VAT inside and not reclaimable. A
 * source whose invoice cannot carry a premium contributes nothing, whatever a stale field says.
 *
 * ONE RULE, TWO READERS: feePosition below (the purchase model) and lib/stock::bookRow (the stock book,
 * and through it the VAT summary's margin-scheme section). The book used to measure margin from the
 * purchase price ALONE, so an auction car's margin VAT was overstated by a sixth of its premium — latent
 * only because nothing showed the book until the VAT summary did.
 */
export function marginBaseFeePence(source: PurchaseSource, premiumPence: number): number {
  return hasFeeSlot(source, 'premium') ? Math.max(0, Math.round(premiumPence)) : 0;
}

export function feePosition(
  source: PurchaseSource,
  fees: { premiumPence: number; servicesPence: number },
  vatRegistered: boolean,
): FeePosition {
  // A FIGURE FOR A FEE THIS INVOICE CANNOT CARRY IS NOT A COST. It is a stale field from a changed
  // answer — a private seller invoices no premium — and reading it would be inventing money.
  const premium = marginBaseFeePence(source, fees.premiumPence);
  // GROSS, like every other money field. It was typed NET until 2026-09-13, which made this the one
  // field on the page asking for a different kind of number — so the VAT is now EXTRACTED (÷ 6) rather
  // than ADDED (× 0.2). One direction of arithmetic everywhere.
  const servicesGross = hasFeeSlot(source, 'services') ? Math.max(0, Math.round(fees.servicesPence)) : 0;
  const servicesVat = Math.round(servicesGross * VAT_FRACTION);
  const reclaimable = vatRegistered ? servicesVat : 0;
  return {
    premiumPence: premium,
    // NET of its own VAT, so a reader of this field gets the cost rather than the payment.
    servicesPence: servicesGross - servicesVat,
    servicesVatPence: servicesVat,
    // THE PREMIUM ONLY. Its VAT is already inside it, which is precisely why it cannot also be reclaimed.
    inMarginBasePence: premium,
    cashOutPence: premium + servicesGross,
    reclaimablePence: reclaimable,
    netCostPence: premium + servicesGross - reclaimable,
  };
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

export const FUNDING_KINDS = ['cash', 'overdraft', 'facility'] as const;
export type FundingKind = (typeof FUNDING_KINDS)[number];

/**
 * ── THREE WAYS OF PAYING FOR A CAR, AND ONLY TWO OF THEM ARE INTEREST ───────────────────────────
 * The cost-of-money slider is an annual percentage. A real stocking facility is not one: NextGear
 * CURTAILS — it demands a slice of the advance back every month — which is a REPAYMENT SCHEDULE, not
 * a rate. Modelling it as an annual percentage gets two things wrong at once: the interest, because
 * the balance declines, and the cash, because money must be found before the car sells.
 *
 *   CASH       own money. The cost is what it would otherwise have earned. Nothing to repay.
 *   OVERDRAFT  interest on a balance that stays flat until the sale, plus an arrangement fee.
 *   FACILITY   advances part of the price, charges a fee per car, charges on the OUTSTANDING
 *              balance, and takes principal back on a schedule whether or not the car has sold —
 *              with a term limit after which the whole balance is due.
 *
 * ── THE NUMBER AN ANNUAL PERCENTAGE CANNOT EXPRESS ──────────────────────────────────────────────
 * CASH BEFORE SALE. At 10% of the advance a month over a ninety-day hold, 30% of the advance is paid
 * back before any buyer appears — £2,400 on an £8,000 car. That is the figure that breaks a garage,
 * and no rate on any slider can say it.
 *
 * ── NO RATE CARD SHIPS AS A DEFAULT ─────────────────────────────────────────────────────────────
 * The facility's fields start at ZERO and the screen asks the garage to read their own agreement.
 * "Roughly 10% a month" is the owner's description of one product, not a fact about every facility,
 * and a default is the strongest claim an interface can make. Same rule as the slider ranges.
 *
 * ── WHY `cash` CARRIES NO RATE OF ITS OWN ───────────────────────────────────────────────────────
 * The annual rate stays on the EXISTING slider. A rate inside the plan as well would be two homes for
 * one number, and the two would diverge the first time somebody edited one of them.
 */
export type FundingPlan =
  | { kind: 'cash' }
  | { kind: 'overdraft'; arrangementFeePence: number }
  | {
      kind: 'facility';
      /** How much of the purchase price the facility advances. The rest is the garage's own deposit. */
      advancePct: number;
      /** The facility's charge, per month, on the OUTSTANDING advance. Not an annual rate. */
      monthlyPctOfAdvance: number;
      /** Principal taken back each month, as a percentage of the ORIGINAL advance. The curtailment. */
      curtailPctPerMonth: number;
      /** Days before the first curtailment falls due. */
      graceDays: number;
      /** A flat charge per car at drawdown. */
      perUnitFeePence: number;
      /** The whole balance is due by this many days. 0 means the agreement's term is not stated. */
      termDays: number;
    };

export type FundingCost = {
  /** The charge for the money, over the days held. */
  interestPence: number;
  /** Flat charges — an arrangement fee, a per-car drawdown fee. */
  feesPence: number;
  /** Both together: the cost of money for this car. */
  totalPence: number;
  /**
   * CASH THE GARAGE MUST FIND BEFORE THE CAR SELLS — curtailments and charges falling due during the
   * hold. Zero for cash and for an overdraft; the whole point of modelling a facility separately.
   */
  cashBeforeSalePence: number;
  /** What falls due when, so the figure above can be read rather than trusted. */
  schedule: { day: number; principalPence: number; chargePence: number }[];
  /**
   * THE HOLD IS LONGER THAN THE AGREEMENT ALLOWS. A refusal, not a cost: the facility does not
   * quietly charge more for day 150 of a 120-day term, it demands the balance. Null when the
   * agreement's term has not been entered — an unknown term is not a satisfied one.
   */
  overTerm: boolean | null;
};

/**
 * WHAT THE MONEY COSTS, BY PLAN. `amountPence` is the cash tied up in the car — cashOut from the VAT
 * position plus any fee, because VAT and an auction premium are out of the bank just as long as the car.
 */
export function fundingCost(
  plan: FundingPlan, args: { amountPence: number; daysInStock: number; annualPct: number },
): FundingCost {
  const amount = Math.max(0, Math.round(args.amountPence));
  const days = Math.max(0, args.daysInStock);
  const simple = Math.round(amount * (args.annualPct / 100) * (days / 365));

  if (plan.kind === 'cash') {
    // IDENTICAL TO WHAT SHIPPED. Simple interest over the days held, on the cash that left the bank.
    // Every model saved before funding existed reads back as this, so its answer cannot move.
    return { interestPence: simple, feesPence: 0, totalPence: simple, cashBeforeSalePence: 0, schedule: [], overTerm: null };
  }
  if (plan.kind === 'overdraft') {
    const fees = Math.max(0, Math.round(plan.arrangementFeePence));
    return {
      interestPence: simple, feesPence: fees, totalPence: simple + fees,
      // The balance is flat until the sale and the interest is small and monthly; nothing is DEMANDED
      // before the car sells, which is the distinction this field exists to draw.
      cashBeforeSalePence: 0, schedule: [], overTerm: null,
    };
  }

  // ── THE FACILITY: A SCHEDULE, WALKED MONTH BY MONTH ────────────────────────────────────────────
  const advance = Math.min(amount, Math.round(amount * (Math.max(0, plan.advancePct) / 100)));
  const fees = Math.max(0, Math.round(plan.perUnitFeePence));
  const curtailEach = Math.round(advance * (Math.max(0, plan.curtailPctPerMonth) / 100));
  const monthlyRate = Math.max(0, plan.monthlyPctOfAdvance) / 100;
  const schedule: FundingCost['schedule'] = [];
  let outstanding = advance;
  let interest = 0;
  let dueBeforeSale = 0;
  // Month ends at 30-day steps after the grace period. Thirty days, not a calendar month: the model
  // has no dates in it — only a number of days held — and inventing a start date to get calendar
  // months would be a precision the input does not carry.
  for (let month = 1; month <= 24 && outstanding > 0; month += 1) {
    const day = Math.max(0, plan.graceDays) + month * 30;
    if (day > days) break;                       // the car sold before this one fell due
    const charge = Math.round(outstanding * monthlyRate);
    const principal = Math.min(outstanding, curtailEach);
    interest += charge;
    outstanding -= principal;
    dueBeforeSale += principal + charge;
    schedule.push({ day, principalPence: principal, chargePence: charge });
  }
  // The part-month the car is held beyond the last curtailment still carries a charge.
  const lastDay = schedule.length ? schedule[schedule.length - 1].day : 0;
  if (outstanding > 0 && days > lastDay) {
    interest += Math.round(outstanding * monthlyRate * ((days - lastDay) / 30));
  }
  return {
    interestPence: interest, feesPence: fees, totalPence: interest + fees,
    cashBeforeSalePence: dueBeforeSale,
    schedule,
    overTerm: plan.termDays > 0 ? days > plan.termDays : null,
  };
}

/** A facility with nothing entered yet. Every figure zero, so it claims nothing until it is filled in. */
export function blankFacility(): FundingPlan {
  return { kind: 'facility', advancePct: 0, monthlyPctOfAdvance: 0, curtailPctPerMonth: 0, graceDays: 0, perUnitFeePence: 0, termDays: 0 };
}

/**
 * ── RECOVERABILITY IS PER COST, NOT PER PAGE ────────────────────────────────────────────────────
 * One garage's recovery man, paint shop and car wash are not VAT registered. Another's haulier and
 * bodyshop are. Same field, same typed figure, and the real cost differs by a fifth depending on who
 * sent the invoice. Until now every cost behaved as though nothing was recoverable — right for the
 * first garage, wrong for the second, and never asked either way.
 *
 * ── THREE STATES, AND TWO OF THEM COST THE SAME. DO NOT COLLAPSE THEM ───────────────────────────
 *   standard_recoverable      standard rated, and it comes back (if the garage is registered)
 *   standard_not_recoverable  standard rated, and it does not — the VAT is real and stays a cost
 *   no_vat                    the supplier does not charge VAT at all: nothing inside the figure
 *
 * The last two produce the SAME arithmetic — cost equals what you paid — and a later reader will be
 * tempted to fold them into a boolean. They must not: they are different facts about the invoice, they
 * differ to an accountant, and only `no_vat` is true of an unregistered supplier. A warranty is the
 * clearest case: insurance-backed cover carries IPT rather than VAT, so there is no input tax in it to
 * argue about, which is a different statement from "there is VAT and we cannot have it back".
 */
export const VAT_TREATMENTS = ['standard_recoverable', 'standard_not_recoverable', 'no_vat'] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/** The costs whose treatment can differ by supplier. Everything else is settled by construction. */
export const FLAGGED_COSTS = ['partsPence', 'warrantyPence', 'deliveryInPence', 'deliveryOutPence', 'advertisingPence'] as const;
export type FlaggedCost = (typeof FLAGGED_COSTS)[number];

/**
 * THE DEFAULTS, AND WHY THEY ARE THE CONSERVATIVE ONES.
 *
 * `standard_not_recoverable` everywhere except the warranty. Two reasons, and the second is stronger:
 * it understates rather than flatters, and it is BYTE-IDENTICAL to the arithmetic that shipped — every
 * cost was already added at its full typed value — so turning this on moves no stored answer at all.
 *
 * The warranty defaults to `no_vat` because insurance-backed cover is the common case and carries no
 * input tax. Same arithmetic as the default above, a different statement about the invoice.
 */
export function defaultCostVat(): Record<FlaggedCost, VatTreatment> {
  return {
    partsPence: 'standard_not_recoverable',
    warrantyPence: 'no_vat',
    deliveryInPence: 'standard_not_recoverable',
    deliveryOutPence: 'standard_not_recoverable',
    advertisingPence: 'standard_not_recoverable',
  };
}

export type CostPosition = {
  /** What leaves the bank: the typed figure, always. */
  cashPence: number;
  /** VAT inside that figure. Zero only when the supplier charges none. */
  vatInsidePence: number;
  /** VAT that comes back — standard-rated AND recoverable AND the garage registered. */
  reclaimablePence: number;
  /** The cost after anything reclaimed. This is what profit is measured against. */
  costPence: number;
};

/**
 * ONE COST, UNDER ONE TREATMENT. The typed figure is GROSS throughout (see GROSS_BASIS_NOTE), so the
 * VAT is extracted rather than added — the same direction as every other calculation on this page.
 */
export function costPosition(grossPence: number, treatment: VatTreatment, vatRegistered: boolean): CostPosition {
  const cash = Math.max(0, Math.round(grossPence));
  if (treatment === 'no_vat') {
    return { cashPence: cash, vatInsidePence: 0, reclaimablePence: 0, costPence: cash };
  }
  const vatInside = Math.round(cash * VAT_FRACTION);
  // RECOVERABLE IS NOT ENOUGH ON ITS OWN. An unregistered garage reclaims nothing from anybody, so the
  // tenant's own registration gates this exactly as it gates the indemnities.
  const reclaimable = treatment === 'standard_recoverable' && vatRegistered ? vatInside : 0;
  return { cashPence: cash, vatInsidePence: vatInside, reclaimablePence: reclaimable, costPence: cash - reclaimable };
}

/**
 * ── AUTOTRADER IS NOT A FIXED OVERHEAD. IT IS SLOTS ─────────────────────────────────────────────
 * The package is X slots, not a lump sum: £5,000 for 50 is £100 per slot per month. A car occupies its
 * slot for as long as it is in stock, so this is a real per-car cost with a KNOWN DENOMINATOR, and it
 * attaches to DAYS IN STOCK — the same driver as the cost of money.
 *
 * That kills the circularity the break-even sentence existed for. "What does advertising cost per car?"
 * could not be answered without knowing how many cars sell; it can be answered from the contract.
 *
 * ── PART THEREOF, NOT PRO-RATA ──────────────────────────────────────────────────────────────────
 * The contract says "or part thereof", so a car held 31 days occupies its slot for two months and costs
 * two. Pro-rata would charge £103.33 where the invoice says £200 — and would smooth away the only thing
 * a dealer can act on this week:
 *
 *     30 days  £100   ·   31 days  £200   ·   the gap at the boundary is £96.67
 *
 * That step is deliberate and must not read as a bug, so the screen shows the boundary: how long the
 * current month covers, and what the next one costs.
 *
 * ── TWO THINGS ARE NOT ANSWERED, AND ARE NOT GUESSED ────────────────────────────────────────────
 * 1. THE TWO PART-EXCHANGE SLOTS for cars under £1,500. Whether they sit inside the package (making the
 *    denominator 52, not 50), are charged separately, or are restricted to cheap cars is UNKNOWN — the
 *    owner is checking the contract. Nothing here models them, and the three readings give different
 *    per-slot costs, so guessing would be wrong by a knowable amount.
 * 2. BILLING GRANULARITY: calendar months, or 30 days from listing. UNKNOWN. This charges in 30-day
 *    periods from day zero, which is the reading that needs no date — the model has no listing date in
 *    it, only a number of days held.
 *
 * NEITHER ANSWER NEEDS A MIGRATION. The package is JSONB and unrecognised keys are ignored on read, so
 * `pxSlots` or `granularity` can be added by a later deploy without touching the schema, and an older
 * reader keeps working while it lands.
 */
export type AdvertisingPackage = {
  /** What the package costs a month, GROSS — the total that leaves the bank. */
  monthlyPence: number;
  /** How many cars it advertises at once. The denominator, and it comes from the contract. */
  slots: number;
  /** How many cars are in stock right now, for the utilisation question. Not part of any car's cost. */
  carsInStock: number;
};

export function emptyAdvertisingPackage(): AdvertisingPackage {
  return { monthlyPence: 0, slots: 0, carsInStock: 0 };
}

/**
 * WHAT ONE SLOT COSTS A MONTH. Null when the package is not described — a per-slot figure derived from
 * a missing slot count would be a division by zero dressed as a cost.
 */
export function perSlotMonthlyPence(pkg: AdvertisingPackage): number | null {
  if (pkg.monthlyPence <= 0 || pkg.slots <= 0) return null;
  return Math.round(pkg.monthlyPence / pkg.slots);
}

export type SlotCharge = {
  /** Months charged: part of a month is a month. Zero days in stock occupies no slot. */
  monthsCharged: number;
  /** What those months cost, GROSS. */
  cashPence: number;
  /** The last day the months already charged cover. */
  coveredUntilDay: number;
  /** Days left before another month is charged. Zero means the next day costs another month. */
  daysBeforeNextCharge: number;
  /** What that next month will cost, so the boundary can be stated in money rather than in days. */
  nextChargePence: number;
};

/**
 * A SLOT, HELD FOR SOME DAYS. Charged in whole 30-day periods because the contract says "or part
 * thereof" — see the note above on why that is not pro-rata and why the step is shown rather than hidden.
 */
export function slotCharge(perSlotPence: number, daysInStock: number): SlotCharge {
  const per = Math.max(0, Math.round(perSlotPence));
  const days = Math.max(0, Math.floor(daysInStock));
  const months = Math.ceil(days / 30);
  const coveredUntilDay = months * 30;
  return {
    monthsCharged: months,
    cashPence: months * per,
    coveredUntilDay,
    daysBeforeNextCharge: Math.max(0, coveredUntilDay - days),
    nextChargePence: per,
  };
}

export type SlotUtilisation = {
  slots: number;
  carsInStock: number;
  /** Slots paid for and not filled. Negative is impossible: more cars than slots is a different problem. */
  emptySlots: number;
  /** What those empty slots cost a month. The question nobody is asking. */
  wastedMonthlyPence: number;
  /** More cars than slots — not waste, but worth saying, because those cars are not advertised. */
  unadvertisedCars: number;
};

/**
 * ARE THE SLOTS FULL? This replaces the break-even sentence, whose premise died with the denominator.
 * "How many sales cover the contract?" was the honest question while the contract looked like a lump
 * sum. It is fully allocated across slots now — so the live question is whether the slots are occupied,
 * and a garage paying for fifty and stocking thirty is burning £2,000 a month with nothing to show it.
 *
 * Null when the package is not described. Nothing is inferred from a blank.
 */
export function slotUtilisation(pkg: AdvertisingPackage): SlotUtilisation | null {
  const per = perSlotMonthlyPence(pkg);
  if (per == null) return null;
  const empty = Math.max(0, pkg.slots - pkg.carsInStock);
  return {
    slots: pkg.slots,
    carsInStock: pkg.carsInStock,
    emptySlots: empty,
    wastedMonthlyPence: empty * per,
    unadvertisedCars: Math.max(0, pkg.carsInStock - pkg.slots),
  };
}

/** A slider: what it is, where it starts, and what counts as a plausible span for it. */
/**
 * WHETHER THIS FIELD CAN CARRY VAT AT ALL, and if so on what basis it is typed.
 *   gross  — a money field carrying VAT: type the total paid. Slice 3 decides whether it comes back.
 *   no_vat — a money field that cannot carry input VAT (wages; exempt interest). Nothing to state.
 *   n/a    — not money. Hours, days, a percentage.
 */
export type FieldBasis = 'gross' | 'no_vat' | 'n/a';

/**
 * ── TWO JOBS THAT WERE ONE NUMBER ───────────────────────────────────────────────────────────────
 * `min`/`max` used to be the validation cap AND the slider's extent AND the sensitivity domain. One
 * field, three jobs, and they only agreed by accident — which surfaced when the ranking on a £1,250
 * Mini put Parts top with a swing measured across £0–£2,000, a range in which most values are
 * impossible for that car.
 *
 * The dangerous half was quieter. lib/purchase-model-store clamps every stored value to `max` ON READ,
 * so the range was never merely an affordance: narrowing it would have silently rewritten saved models
 * — a £900 engine on a cheap car becoming £500 the next time somebody opened it, and its profit with it.
 *
 *   capMin / capMax   VALIDATION. What a stored value is clamped to. STATIC, never scaled, and
 *                     deliberately unchanged from the single range that preceded the split, so no
 *                     stored value can move.
 *   scale             THE SWING THE RANKING USES — and, since 2026-09-14, NOTHING ELSE.
 *                     Absent means this slider never scales, which is most of them.
 *
 * ── WHY scale NO LONGER TOUCHES THE CONTROL ────────────────────────────────────────────────────
 * One field was answering two different questions and getting one of them wrong.
 *
 *   "What may I enter?"          — never car-scaled. A £750 car offered £0–£500 of parts, so a real
 *                                  £1,800 engine could not be typed at all. A cheap car is exactly the
 *                                  one that needs an engine; the ceiling was tightest where the spend
 *                                  is most likely to be large. The person holding the invoice knows
 *                                  more about this car than a ratio does.
 *
 *   "What would plausibly move   — car-aware, and must stay so. Swinging Parts across £0–£3,500 on a
 *    this the most?"               £1,250 Mini puts Parts top of the ranking BY CONSTRUCTION, on a
 *                                  domain most of that car cannot occupy. Measured across its own
 *                                  £0–£500 the top lever becomes workshop time, which is what the car
 *                                  actually says.
 *
 * So `sliderRange` (the control) is the static cap, and `swingRange` (the ranking) keeps the scaling.
 * Answering both from one function is what made removing the entry ceiling look like it had to cost
 * the ranking its honesty. It does not.
 */
export type SliderDef = {
  key: SliderKey; label: string; unit: 'money' | 'hours' | 'days' | 'percent';
  /** Declared per slider so the note and the arithmetic cannot drift apart. */
  basis: FieldBasis;
  capMin: number; capMax: number; step: number; def: number;
  /**
   * HOW THE VISIBLE RANGE NARROWS WITH THE CAR. Only where the cost genuinely tracks what the car is
   * worth. The coefficients are chosen so an £8,000 car — the default — gets EXACTLY its old range, so
   * this is a fix for cheap cars and not a change to every model.
   */
  scale?: { pctOfPurchase: number; floorPence: number };
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
  { key: 'prepHours', basis: 'n/a', label: 'Prep hours', unit: 'hours', capMin: 0, capMax: 40, step: 0.5, def: 4,
    note: 'Workshop time before it goes on sale — valet, MOT, service, the small jobs.' },
  { key: 'partsPence', basis: 'gross', label: 'Parts', unit: 'money', capMin: 0, capMax: 350000, step: 2500, def: 25000,
    // 25% of an £8,000 car is £2,000 — its old range exactly. £500 floor: a cheap car can still need a clutch.
    scale: { pctOfPurchase: 0.25, floorPence: 50000 },
    note: 'Parts and consumables fitted during prep, at cost.' },
  { key: 'daysInStock', basis: 'n/a', label: 'Days in stock', unit: 'days', capMin: 0, capMax: 180, step: 5, def: 45,
    note: 'Bought to sold. This is what the cost of money is charged over.' },
  { key: 'advertisingPence', basis: 'gross', label: 'Additional advertising', unit: 'money', capMin: 0, capMax: 30000, step: 500, def: 6000,
    // ── THE SPLIT IS BY PLATFORM, NOT BY COST SHAPE (owner, 2026-09-13) ─────────────────────────
    // Autotrader is the industry standard and carries its own named monthly line; this slider is
    // EVERYTHING ELSE, and it is per car because that spend genuinely is. The note names the examples
    // rather than describing a category, because "additional" only means something once you know what
    // it is additional to.
    //
    // It was 'Advertising' with the note "Per car, across every platform it is listed on" — which the
    // product cannot deliver, because the dominant platform is a subscription and no per-car figure for
    // a fixed cost has a denominator this page knows.
    note: 'eBay, Gumtree, Facebook Marketplace, a paid boost, photography — anything beyond the Autotrader subscription.' },
  { key: 'warrantyPence', basis: 'gross', label: 'Warranty', unit: 'money', capMin: 0, capMax: 100000, step: 2500, def: 15000,
    // 12.5% of £8,000 is £1,000 — its old range exactly. A provision tracks what the car is worth.
    scale: { pctOfPurchase: 0.125, floorPence: 25000 },
    note: 'What you expect this car to cost you after it leaves — provision, not a policy price.' },
  { key: 'deliveryInPence', basis: 'gross', label: 'Delivery in', unit: 'money', capMin: 0, capMax: 50000, step: 1000, def: 12000,
    note: 'Getting it from the auction or the seller to you.' },
  { key: 'deliveryOutPence', basis: 'gross', label: 'Delivery out', unit: 'money', capMin: 0, capMax: 50000, step: 1000, def: 0,
    note: 'Getting it to the buyer, if you are paying for that.' },
  { key: 'workshopCostPerHourPence', basis: 'no_vat', label: 'Workshop cost per hour', unit: 'money', capMin: 2000, capMax: 9000, step: 250, def: 4500,
    note: 'What an hour in your workshop COSTS you — not what you charge. A slider until the standing-still rate exists.' },
  { key: 'costOfMoneyAnnualPct', basis: 'n/a', label: 'Cost of money', unit: 'percent', capMin: 0, capMax: 20, step: 0.5, def: 9,
    // WAS: "stocking finance, an overdraft, or what the cash would otherwise earn" — three things with
    // different shapes behind one annual rate. A facility is a repayment schedule and now has its own
    // model, so this rate is the one that applies to the two that genuinely ARE rates.
    note: 'Annual rate on your own money or an overdraft. A stocking facility is not a rate — choose it below instead.' },
];

/**
 * A STEP THAT SUITS THE RANGE, and never coarser than the slider already was. Narrowing warranty to
 * £250 while leaving a £25 step would give ten notches — a control that cannot express £137. Only ever
 * finer, so the £8,000 car keeps the exact step it has.
 */
function niceStep(maxPence: number, defaultStep: number): number {
  const candidates = [100, 250, 500, 1000, 2500, 5000, 10000];
  const fits = candidates.find((c) => maxPence / c <= 40) ?? defaultStep;
  return Math.min(defaultStep, fits);
}

export type SliderRange = {
  min: number; max: number; step: number;
  /** Whether the car narrowed this range. False for the sliders that never scale. */
  scaled: boolean;
  /** Whether the CURRENT VALUE pushed the range back out past the scaled maximum. */
  widened: boolean;
};

/**
 * THE RANGE A PERSON SEES AND THE RANKING MEASURES. Not the validation cap — see the note on SliderDef.
 *
 * ── IT ALWAYS CONTAINS THE CURRENT VALUE ────────────────────────────────────────────────────────
 * A £1,250 car scales Parts to £0–£500. A stored model with a £900 engine in it must still show that
 * £900: a control that cannot reach its own value is broken, and a control that CLAMPS to reach it has
 * rewritten a saved answer. So the range widens instead, and says why.
 *
 * ── WHAT DOES NOT SCALE, AND WHY EACH ONE ───────────────────────────────────────────────────────
 * Only parts and warranty carry a `scale`. Prep hours do not — a cheap car often needs MORE work, so
 * scaling them would be wrong rather than merely unhelpful. Delivery does not — a transporter from
 * Leeds to Tipton costs the same for a Mini as for an ML350, and on YP61LBF £250 of delivery against a
 * £1,250 hammer would have been called implausible by any value-scaled range. Workshop cost per hour is
 * a property of the business, not the car. Days and rates are not money.
 */
/**
 * WHAT THE CONTROL SPANS. The validation cap, always — no car narrows it. `scaled` and `widened` are
 * retained as `false` so callers that render them keep compiling; they describe a narrowing this
 * function no longer does, and a reader who sees them false is being told the truth.
 */
export function sliderRange(s: SliderDef): SliderRange {
  return { min: s.capMin, max: s.capMax, step: s.step, scaled: false, widened: false };
}

/**
 * WHAT THE RANKING SWINGS ACROSS — the old scaled range, now used for the one question it was always
 * right about. Still contains the current value: swinging across a domain that excludes where the
 * person actually is would rank a move they have already made as impossible.
 */
export function swingRange(s: SliderDef, purchasePence: number, currentValue: number): SliderRange {
  if (!s.scale) return { min: s.capMin, max: s.capMax, step: s.step, scaled: false, widened: false };
  const scaledMax = Math.max(s.scale.floorPence, Math.round(Math.max(0, purchasePence) * s.scale.pctOfPurchase));
  const max = Math.min(s.capMax, Math.max(scaledMax, Math.round(currentValue)));
  return {
    min: s.capMin,
    max,
    step: niceStep(max, s.step),
    scaled: true,
    widened: max > scaledMax,
  };
}

export type ModelInputs = {
  purchasePence: number; salePence: number; vatStatus: VatStatus;
  /**
   * WHAT A SLOT COST A MONTH WHEN THIS CAR WAS MODELLED. SEEDED from the garage's package and then
   * owned by the model — if the arithmetic read the package live, renegotiating the contract would
   * silently rewrite every car already modelled. Freeze what the document was ABOUT; read live what it
   * is SUBJECT TO (which is why `vatRegistered` goes the other way, as an option).
   *
   * Zero when the garage has not described its package, and then no slot cost is charged at all.
   *
   * IT REPLACED `autotraderMonthlyPence`, which existed for a few hours between the platform split and
   * the slot model. That field was the monthly LUMP, typed per model, and its only job was the
   * break-even sentence — both of which the slot count made unnecessary.
   */
  slotCostPerMonthPence: number;
  /** WHERE IT CAME FROM. Decides what a fee does, and what the VAT toggle is allowed to say. */
  source: PurchaseSource;
  /**
   * HOW EACH COST'S SUPPLIER CHARGES VAT. Per model, seeded from the tenant's remembered answers — a
   * garage's paint shop does not change between cars, but one car can go to a registered bodyshop.
   */
  costVat: Record<FlaggedCost, VatTreatment>;
  /**
   * HOW THE CAR IS PAID FOR. Absent in every model saved before 2026-09-13, and the store maps that
   * to `{ kind: 'cash' }`, whose arithmetic is exactly what shipped — so no stored answer moves.
   */
  funding: FundingPlan;
  /**
   * THE BUYER'S PREMIUM, typed exactly as the invoice prints it — VAT INSIDE, nothing added and nothing
   * recovered. Auction invoices only; SOURCE_RULES decides that, not this field.
   */
  premiumPence: number;
  /**
   * STANDARD-RATED SERVICES on the purchase invoice: an auction's indemnities, a dealer's admin fee.
   * TYPED GROSS, like every other money field — the total paid, VAT included. One field because the
   * mechanism is identical; the LABEL differs by source because the words on the invoice differ, and
   * those are the words the garage is reading.
   */
  servicesPence: number;
  /**
   * WHICH CONVENTION `servicesPence` WAS TYPED ON. 'gross' from 2026-09-13; ABSENT means a document
   * written before that, when this field alone asked for the NET figure. £68 net and £68 gross are the
   * same number, so the document must say which — see toGross in lib/purchase-model-store.
   */
  feeEntryBasis?: 'gross';
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
  return { purchasePence: 800000, salePence: 1000000, vatStatus: 'margin', purchaseIncludesVat: false, source: 'auction', premiumPence: 0, servicesPence: 0,
    funding: { kind: 'cash' }, costVat: defaultCostVat(), slotCostPerMonthPence: 0, ...sliders };
}

/**
 * ── GROSS PROFIT ON THIS CAR, AND WHAT THAT EXCLUDES (owner, 2026-09-13) ────────────────────────
 * This model counts what the CAR costs. It counts nothing the business pays whether or not the car
 * exists — the Autotrader subscription, rent, insurance, the phone bill — and it counts no tax.
 *
 * The bare word "Profit" was the original defect: in 24px bold it read as the bottom line, the same
 * class of error as a swing read as a cost. The answer is not to avoid the word but to QUALIFY it.
 * "Gross profit on this car" says WHICH profit, and the screen names both exclusions underneath:
 * "Before your fixed monthly costs and tax." Two named exclusions, neither claiming to be the only one.
 *
 * ── ONE NAME FOR ONE NUMBER, AND ONE STATED MISMATCH ────────────────────────────────────────────
 * The field and the screen now agree. Only the COLUMN differs — `profit_pence`, because renaming it is
 * a constraining migration for a word — and that single mismatch is stated at the one line that crosses
 * the boundary, in lib/purchase-model-store. The number went profitPence, then contributionPence, now
 * grossProfitPence; three unstated names for one number was the outcome to avoid, so the middle one is
 * gone rather than layered under the new one.
 */
export type ModelResult = {
  vat: VatPosition;
  /** What the buyer's fee did — to the bank, to the margin, and to the cost. */
  fee: FeePosition;
  /** What the money cost, and what must be repaid before the car sells. */
  funding: FundingCost;
  /** Each flagged cost, as cash and as cost — they differ wherever the VAT comes back. */
  costs: ({ key: FlaggedCost } & CostPosition)[];
  /** The advertising slot: months charged, and where the next boundary falls. */
  slot: SlotCharge;
  /** That slot as cash and as cost — Autotrader's VAT is recoverable, so the two differ. */
  slotCost: CostPosition;
  /** VAT recoverable across all the costs. Named separately because it lands on the next return. */
  costVatReclaimablePence: number;
  /** What those costs take out of the bank, before any recovery. */
  costCashPence: number;
  vatDuePence: number;
  workshopCostPence: number;
  stockingCostPence: number;
  otherCostsPence: number;
  totalCostsPence: number;
  grossProfitPence: number;
  /** Profit before the two costs a garage rarely counts, so the tool can show what they take out. */
  grossProfitBeforeWorkshopAndMoneyPence: number;
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
  const fee = feePosition(i.source, { premiumPence: i.premiumPence, servicesPence: i.servicesPence }, opts.vatRegistered === true);
  const vat = vatPosition(i.purchasePence, i.salePence, i.vatStatus, i.purchaseIncludesVat,
    i.purchasePence + fee.inMarginBasePence);
  const workshop = Math.round(i.prepHours * i.workshopCostPerHourPence);
  // ON THE CASH, NOT THE COST. The VAT on a plus-VAT purchase is out of the bank until the next
  // return; interest is paid on money that has gone, not on money that will come back.
  // ON THE CASH, FEE INCLUDED. The fee leaves the bank with the car and is tied up just as long.
  const cashOut = vat.cashOutPence + fee.cashOutPence;
  // THROUGH THE PLAN, ALWAYS — including `cash`, whose branch is the arithmetic that shipped. Keeping
  // one path means the comparison panel and the answer cannot drift apart, which a second copy of the
  // simple-interest line here would guarantee within a slice or two.
  const funding = fundingCost(i.funding, {
    amountPence: cashOut, daysInStock: i.daysInStock, annualPct: i.costOfMoneyAnnualPct,
  });
  const stocking = funding.totalPence;
  // ── EACH COST THROUGH ITS OWN TREATMENT ────────────────────────────────────────────────────────
  // The typed figures are gross; what a cost COSTS depends on who invoiced it. Summed as cost, not as
  // cash — profit is measured against what the car actually costs, and a recoverable cost costs less
  // than it takes out of the bank. With every treatment at its default this is the arithmetic that
  // shipped, to the penny, because nothing was recoverable before.
  const costs = FLAGGED_COSTS.map((k) => ({ key: k, ...costPosition(i[k], i.costVat[k], opts.vatRegistered === true) }));
  /**
   * THE SLOT, CHARGED ACROSS THE DAYS HELD. Autotrader is VAT registered and its VAT is recoverable by
   * a registered garage, so this needs no supplier flag — it is settled by construction, unlike a paint
   * shop that may or may not charge VAT at all.
   */
  const slot = slotCharge(i.slotCostPerMonthPence, i.daysInStock);
  const slotCost = costPosition(slot.cashPence, 'standard_recoverable', opts.vatRegistered === true);
  const other = costs.reduce((a, c) => a + c.costPence, 0) + slotCost.costPence;
  const costVatReclaimable = costs.reduce((a, c) => a + c.reclaimablePence, 0) + slotCost.reclaimablePence;
  const costCash = costs.reduce((a, c) => a + c.cashPence, 0) + slotCost.cashPence;
  const total = workshop + stocking + other;
  // Revenue net of the VAT charged on the sale, less what the car and the fee actually cost after any
  // reclaim. The fee's VAT is netted HERE when the source makes it separately reclaimable; when the
  // source folds the fee into the goods price it is already relieved through the margin above, and
  // counting it in both places is exactly what the invariant forbids.
  const gross = i.salePence - vat.outputVatPence - vat.netCostPence - fee.netCostPence;
  return {
    vat, fee, funding, costs, slot, slotCost,
    costVatReclaimablePence: costVatReclaimable, costCashPence: costCash,
    /**
     * WHAT ACTUALLY REACHES HMRC — output VAT less EVERY input tax the car generates, not just the
     * VAT inside the purchase. It used to be vat.vatToHmrcPence, which nets only the purchase, so a
     * margin car with £13.60 of indemnity VAT showed £414.13 against a return that says £400.53. The
     * profit was right and the line was not, which is the worse of the two: a figure a person can
     * check against a document they already have, and lose confidence in the whole tool over.
     *
     * Three sources of input tax, and all three belong here: the purchase (qualifying only, already
     * inside vat.vatToHmrcPence), the indemnities, and any cost whose supplier VAT is recoverable.
     */
    vatDuePence: vat.vatToHmrcPence - fee.reclaimablePence - costVatReclaimable,
    workshopCostPence: workshop, stockingCostPence: stocking,
    otherCostsPence: other, totalCostsPence: total,
    grossProfitPence: gross - total,
    grossProfitBeforeWorkshopAndMoneyPence: gross - other,
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
    // THE RANGE ON SCREEN, not the validation cap. Measured across £0–£2,000 of parts, a £1,250 Mini
    // ranked Parts first on a domain most of which that car cannot occupy; measured across its own
    // £0–£500 it ranks fifth, and the top lever becomes the workshop time — which is what the car says.
    const r = swingRange(s, i.purchasePence, i[s.key]);
    // THE SAME OPTIONS AS THE ANSWER. A ranking computed against a different model from the figure
    // above it would be a list of swings in a world the person is not looking at.
    const low = computeModel({ ...i, [s.key]: r.min }, opts).grossProfitPence;
    const high = computeModel({ ...i, [s.key]: r.max }, opts).grossProfitPence;
    return { key: s.key, label: s.label, swingPence: Math.abs(high - low) };
  });
  // Descending by swing; ties by the slider's own order, so the list never jitters between equal rows.
  return rows.sort((a, b) => b.swingPence - a.swingPence
    || SLIDERS.findIndex((s) => s.key === a.key) - SLIDERS.findIndex((s) => s.key === b.key));
}

/**
 * ── THE BREAK-EVEN SENTENCE IS GONE, AND SO IS ITS PREMISE ──────────────────────────────────────
 * `salesToCoverMonthly(grossProfit, monthlyFixed)` asked how many sales would cover the advertising
 * contract, because the contract looked like a lump sum with no denominator. The contract states its
 * slot count, so the cost is fully allocated per car and there is no unallocated overhead left to
 * cover. Keeping the sentence would have been answering a question that had stopped being asked.
 *
 * slotUtilisation replaces it with the question the slot count makes available: are the slots full?
 */

/**
 * CLAMP TO THE VALIDATION CAP — never to the displayed range. The store calls this on every read, so
 * clamping to a scaled range would rewrite a stored value whenever the car it belongs to made that
 * range narrower. The cap is static and unchanged from before the split, so nothing stored can move.
 */
export function clampSlider(key: SliderKey, value: number): number {
  const s = SLIDERS.find((x) => x.key === key);
  if (!s) return value;
  if (!Number.isFinite(value)) return s.def;
  return Math.min(s.capMax, Math.max(s.capMin, value));
}
