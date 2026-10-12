/**
 * File: lib/quote-options.ts
 *
 * OPTIONS ON A QUOTE, AND WHAT A CUSTOMER'S CHOICE RESOLVES TO. Pure: no database, no Prisma, so
 * every rule here is testable without arranging a quote.
 *
 * ── TWO KINDS, DELIBERATELY NOT COLLAPSED ───────────────────────────────────────────────────────
 *   ADDITIONS are CUMULATIVE — the main quote plus any of them. An engine rebuild, optionally with
 *   the water pump, optionally with the clutch. None, some or all.
 *   VARIATIONS are EXCLUSIVE — at most one from a group. Bronze, silver, gold.
 *
 * They look similar on a screen and behave oppositely in arithmetic, so they are separate kinds
 * rather than one kind with a flag. A quote may hold both.
 *
 * ── AT MOST ONE, NEVER EXACTLY ONE ──────────────────────────────────────────────────────────────
 * A variation group has no default and declining every variation is a legitimate answer (owner's
 * ruling, 2026-10-12: "forcing a choice turns a quote into an invoice"). So `null` for a group is
 * valid everywhere below, and nothing here treats an unchosen group as an error.
 *
 * ── THE PRINTED DOCUMENT MUST NEVER REQUIRE ARITHMETIC ──────────────────────────────────────────
 * That single rule drives the layout half of this file. A variation prints a COMPLETE price
 * including the main work, never a difference from the cheapest one: a reader comparing three
 * differences will add one of them to the wrong base. And there is NO grand total while a choice is
 * open, because one big number on a page showing three mutually exclusive prices is the one thing
 * guaranteed to be misread.
 */

/** DiscountLine's shape is lib/promo's, deliberately: one answer to "how does a discount reach a
 *  document". exPennies is a POSITIVE magnitude and the caller stores it as a negative line. */
export type DiscountLine = { label: string; exPennies: number; vatable: boolean };

/**
 * lib/promo's DiscountLine plus the frozen gross effect. The extra field exists so a caller never
 * has to recover it by matching on the LABEL — a number reconstructed from a string that another
 * line of code happened to write is identical by construction until somebody edits the wording.
 */
export type ResolvedDiscount = DiscountLine & { grossOffPennies: number };

export const OPTION_KINDS = ['addition', 'variation'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];
export const isOptionKind = (v: unknown): v is OptionKind =>
  (OPTION_KINDS as readonly string[]).includes(String(v));

/**
 * ── TWO INCENTIVE SHAPES, BECAUSE THEY DO DIFFERENT ARITHMETIC ──────────────────────────────────
 * `amount_off` REDUCES the bill: "£50 off if you take the water pump with the main quote". It
 * becomes a negative line and the total moves.
 *
 * `included` GIVES something: "free diagnostic with gold". It becomes a line at zero and the total
 * does NOT move. Expressing it as a discount would subtract the price of something that was never
 * charged for, so the customer would see the bill fall by £X for an item that is not on it.
 *
 * One mechanism for both would have been tidier and wrong in one of the two cases.
 */
export type Incentive =
  /**
   * `exPennies` + `vatable` are what the negative LINE needs (lib/promo's convention).
   * `grossOffPennies` is what the DOCUMENT promises, frozen, because a vatable discount reduces
   * the VAT as well and this module does not know the rate — lib/quote-totals owns that
   * recompute. Carrying both means the printed price and the minted line cannot disagree.
   */
  | { kind: 'amount_off'; label: string; exPennies: number; vatable: boolean; grossOffPennies: number }
  | { kind: 'included'; label: string };

export type OptionLite = {
  id: string;
  kind: OptionKind;
  /** Variations only: which exclusive set this belongs to. NULL on an addition, always. */
  groupKey: string | null;
  title: string;
  position: number;
  /** FROZEN on the option at send. Never recomputed here — this module does display arithmetic on
   *  figures somebody else froze, and recomputing them would be a second spelling of the totals. */
  netPennies: number;
  vatPennies: number;
  grossPennies: number;
  incentive: Incentive | null;
};

/** The main quote as sent, excluding every option. See GROSS_PENNIES_MEANS below. */
export type MainLite = { netPennies: number; vatPennies: number; grossPennies: number };

/**
 * ── THE STATED RULE FOR QuoteVersion.gross_pennies ──────────────────────────────────────────────
 * `gross_pennies` is THE MAIN QUOTE AS SENT, EXCLUDING OPTIONS. Eight readers across
 * lib/quotes-list and lib/quotes-metrics already treat it as "the value of this quote" — Awaiting,
 * declined totals, expired totals, the first-quote figure — and a quote with three variations has
 * no single value, so the alternative is eight separate inferences about which number it holds.
 *
 * It is stated here, once, and asserted against the arithmetic that depends on it rather than left
 * as a convention in a comment: a version's frozen gross must equal the main block's gross, never
 * the sum of everything on offer.
 */
export const GROSS_PENNIES_MEANS =
  'QuoteVersion.gross_pennies is the MAIN quote as sent, excluding all options. '
  + 'A quote with options has no single value until a customer chooses.';

/** TRUE when a frozen version total agrees with the stated rule. */
export const grossAgreesWithRule = (versionGrossPennies: number, main: MainLite): boolean =>
  versionGrossPennies === main.grossPennies;

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT MAY BE SENT
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Refuses a set of options that cannot be presented honestly. Each rule exists because the document
 * would otherwise be ambiguous to somebody holding it, not because the data would be untidy.
 */
export function optionsRefusal(options: readonly OptionLite[]): string | null {
  for (const o of options) {
    if (!isOptionKind(o.kind)) return `“${o.title}” has no kind, so nothing knows whether it adds to the quote or replaces part of it`;
    if (o.kind === 'variation' && !o.groupKey?.trim()) return `“${o.title}” is a variation with no group, so nothing knows what it is an alternative TO`;
    if (o.kind === 'addition' && o.groupKey) return `“${o.title}” is an addition in a group; additions are cumulative and belong to no exclusive set`;
    if (!o.title?.trim()) return 'an option with no title cannot be chosen on a printed page';
    if (o.grossPennies < 0) return `“${o.title}” has a negative price; a reduction is a discount, not an option`;
    if (o.incentive?.kind === 'amount_off') {
      if (!(o.incentive.exPennies > 0)) return `the incentive on “${o.title}” takes nothing off, so printing it would promise a saving of zero`;
      // Gross cannot be below ex, and with no VAT on it the two must be the same number. Either way
      // round, a mismatch means the printed saving and the line on the invoice would differ.
      if (o.incentive.grossOffPennies < o.incentive.exPennies) return `the incentive on “${o.title}” takes more off the net than off the total, which cannot be true`;
      if (!o.incentive.vatable && o.incentive.grossOffPennies !== o.incentive.exPennies) {
        return `the incentive on “${o.title}” carries no VAT, so the saving off the total must equal the saving off the net`;
      }
    }
    if (o.incentive && !o.incentive.label?.trim()) return `the incentive on “${o.title}” has no wording, and an unexplained discount on a document is worse than none`;
  }
  // A group of one is not a choice — it is an addition wearing the wrong kind, and it would print
  // under "Choose one" with one row.
  const groups = variationGroups(options);
  for (const [key, members] of groups) {
    if (members.length < 2) return `variation group “${key}” has only “${members[0]?.title ?? 'one option'}” in it; a single exclusive choice is an addition`;
  }
  const titles = options.map((o) => o.title.trim().toLowerCase());
  const dupe = titles.find((t, i) => titles.indexOf(t) !== i);
  if (dupe) return `two options are both called “${dupe}”, so a customer cannot say which they meant`;
  return null;
}

/** Variation groups in document order, each in position order. Additions are not groups. */
export function variationGroups(options: readonly OptionLite[]): Map<string, OptionLite[]> {
  const m = new Map<string, OptionLite[]>();
  for (const o of [...options].sort((a, b) => a.position - b.position)) {
    if (o.kind !== 'variation' || !o.groupKey) continue;
    const list = m.get(o.groupKey) ?? [];
    list.push(o);
    m.set(o.groupKey, list);
  }
  return m;
}

export const additions = (options: readonly OptionLite[]): OptionLite[] =>
  options.filter((o) => o.kind === 'addition').sort((a, b) => a.position - b.position);

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A CUSTOMER CHOSE
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export type Selection = {
  additionIds: readonly string[];
  /** groupKey → chosen option id, or NULL for "none of these", which is a legitimate answer. */
  variationByGroup: Readonly<Record<string, string | null>>;
};

export type Resolution = {
  chosenAdditions: OptionLite[];
  chosenVariations: OptionLite[];
  /** Positive magnitudes, for the caller to store as negative lines (lib/promo's convention). */
  discounts: ResolvedDiscount[];
  /** Things given rather than discounted: a zero-priced line, and the total does not move. */
  includedLabels: string[];
  /**
   * FROZEN FIGURES ADDED UP, FOR A SCREEN. Not the authority: the minted version's totals are
   * recomputed by lib/quote-totals over the resolved lines, because a vatable discount changes the
   * VAT and that recompute has one home. Computing net and VAT here as well would be a second
   * spelling of the totals, which is how the two drift.
   */
  displayGrossPennies: number;
};

/**
 * Resolves a selection into the chosen options and the extra lines it implies. REFUSES rather than guesses:
 * an acceptance is the act the job card, the parts and the invoice all follow from, so a selection
 * that does not make sense must not be silently narrowed to one that does.
 */
export function resolveSelection(
  main: MainLite, options: readonly OptionLite[], sel: Selection,
): { ok: true; resolution: Resolution } | { ok: false; refusal: string } {
  const byId = new Map(options.map((o) => [o.id, o] as const));
  const groups = variationGroups(options);

  const seen = new Set<string>();
  const chosenAdditions: OptionLite[] = [];
  for (const id of sel.additionIds) {
    const o = byId.get(id);
    if (!o) return { ok: false, refusal: 'That choice is no longer on this quote. Ask the garage to send it again.' };
    if (o.kind !== 'addition') return { ok: false, refusal: `“${o.title}” is one of a set of alternatives, not an extra` };
    // Twice is ambiguous: it could be a double-click or a request for two. Neither is assumable.
    if (seen.has(id)) return { ok: false, refusal: `“${o.title}” was chosen twice` };
    seen.add(id);
    chosenAdditions.push(o);
  }

  const chosenVariations: OptionLite[] = [];
  for (const [key, members] of groups) {
    const picked = sel.variationByGroup[key] ?? null;
    if (picked === null) continue; // "none of these" — legitimate, never an error
    const o = byId.get(picked);
    if (!o) return { ok: false, refusal: 'That choice is no longer on this quote. Ask the garage to send it again.' };
    if (!members.some((m) => m.id === o.id)) return { ok: false, refusal: `“${o.title}” is not one of the alternatives in “${key}”` };
    chosenVariations.push(o);
  }
  // A group the selection never mentioned is "none", the same as an explicit null. A group mentioned
  // that does not exist is a stale document, which is the same situation as a missing option.
  for (const key of Object.keys(sel.variationByGroup)) {
    if (!groups.has(key) && sel.variationByGroup[key] !== null) {
      return { ok: false, refusal: 'That choice is no longer on this quote. Ask the garage to send it again.' };
    }
  }

  const chosen = [...chosenAdditions, ...chosenVariations];
  const discounts: ResolvedDiscount[] = [];
  const includedLabels: string[] = [];
  for (const o of chosen.sort((a, b) => a.position - b.position)) {
    if (!o.incentive) continue;
    if (o.incentive.kind === 'amount_off') {
      discounts.push({ label: o.incentive.label, exPennies: o.incentive.exPennies,
        vatable: o.incentive.vatable, grossOffPennies: o.incentive.grossOffPennies });
    } else {
      includedLabels.push(o.incentive.label);
    }
  }

  const displayGrossPennies = main.grossPennies
    + chosen.reduce((a, o) => a + o.grossPennies, 0)
    - chosen.reduce((a, o) => a + amountOff(o), 0);
  return { ok: true, resolution: { chosenAdditions, chosenVariations, discounts, includedLabels, displayGrossPennies } };
}

/** Nothing chosen at all — the main quote on its own. Still an acceptance. */
export const emptySelection = (): Selection => ({ additionIds: [], variationByGroup: {} });

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE PRINTED PAGE SHOWS
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export type PrintedVariationRow = {
  optionId: string; title: string;
  /** COMPLETE: the main quote plus this variation. Never a difference from the cheapest one. */
  completeGrossPennies: number;
  incentiveNote: string | null;
};
export type PrintedAdditionRow = {
  optionId: string; title: string;
  ownGrossPennies: number;
  /** The main quote plus this one addition, so the reader never adds anything up. */
  withMainGrossPennies: number;
  incentiveNote: string | null;
};
export type PrintedQuote = {
  mainGrossPennies: number;
  variationGroups: { groupKey: string; rows: PrintedVariationRow[] }[];
  additions: PrintedAdditionRow[];
  /**
   * NULL whenever a choice is open. A document showing three mutually exclusive prices and one
   * grand total is the single most misreadable thing we could print, so the total belongs to the
   * choices and the page says what is still to decide.
   */
  grandTotalPennies: number | null;
  openChoices: string[];
};

export function printedQuote(main: MainLite, options: readonly OptionLite[]): PrintedQuote {
  const groups = [...variationGroups(options)].map(([groupKey, members]) => ({
    groupKey,
    rows: members.map((o) => ({
      optionId: o.id, title: o.title,
      completeGrossPennies: main.grossPennies + o.grossPennies - amountOff(o),
      incentiveNote: incentiveNote(o),
    })),
  }));
  const adds = additions(options).map((o) => ({
    optionId: o.id, title: o.title,
    ownGrossPennies: o.grossPennies,
    withMainGrossPennies: main.grossPennies + o.grossPennies - amountOff(o),
    incentiveNote: incentiveNote(o),
  }));
  const open: string[] = [];
  for (const g of groups) open.push(`which ${g.groupKey}`);
  if (adds.length) open.push(adds.length === 1 ? 'whether to add the extra' : 'which extras to add');
  return {
    mainGrossPennies: main.grossPennies,
    variationGroups: groups,
    additions: adds,
    grandTotalPennies: open.length ? null : main.grossPennies,
    openChoices: open,
  };
}

/** What the incentive takes off the TOTAL, as frozen. Never the ex-VAT figure — that is the line. */
const amountOff = (o: OptionLite): number => (o.incentive?.kind === 'amount_off' ? o.incentive.grossOffPennies : 0);

/**
 * An UNTRIGGERED incentive prints as an offer and never as a number in any total. If it could appear
 * in a total the document would contradict itself depending on who read it.
 */
export function incentiveNote(o: OptionLite): string | null {
  if (!o.incentive) return null;
  return o.incentive.kind === 'included'
    ? `Includes ${o.incentive.label}`
    : `${o.incentive.label} — already taken off the price shown`;
}
