/**
 * File: lib/quote-options.ts
 *
 * WHAT A QUOTE OFFERS, AND WHAT A CUSTOMER CAN SAY BACK TO IT.
 *
 * Pure. No database, no formatting, no money type — pennies in, pennies out — so every rule below
 * can be planted and watched fail in quote-options-gate.
 *
 * ── GROUPS, AND WHY THE GROUP IS THE THING ──────────────────────────────────────────────────────
 * This used to be a flat list of options with `kind: 'addition' | 'variation'` and a bare
 * `group_key` string that only variations were allowed to use. That carried a set of alternatives
 * and nothing else. It could not say "a base job plus any of these add-ons", because the add-ons
 * only exist if the base is happening, and nothing in a flat list holds that dependency.
 *
 * So the GROUP is a row, and it carries the SHAPE:
 *
 *   base_plus_extras — one base job, plus any number of tickable extras. The extras exist BECAUSE
 *                      the base is happening: decline the base and the extras go with it. A group
 *                      with NO base member is the unification of what used to be a standalone
 *                      `addition`: the base is then the MAIN QUOTE, which is always happening, so
 *                      the extras stand on their own. That is the only meaning of a missing base.
 *
 *   pick_one        — a set of alternatives. Choose one, or none. Nothing underneath them.
 *
 * GROUPS ARE INDEPENDENT. All, some or none, and NONE IS A VALID ANSWER TO EACH — so a selection
 * that does not mention a group is not an incomplete selection, it is a decline. The old shape had
 * `additionIds` and `variationByGroup` as two different mechanisms; one `byGroup` map says the same
 * thing for both shapes and cannot drift between them.
 *
 * ── WHERE AN INCENTIVE LIVES, AND WHAT WILL REOPEN THAT ─────────────────────────────────────────
 * On the OPTION, not the group. A group-level incentive needs a rule for how it combines with a
 * member's own, and that rule has not been asked for.
 *
 * NOTED BECAUSE IT WILL COME BACK (owner, 2026-10-13): "10% off any service while the car is in"
 * is the offer this was built for, and authoring it four times across a pick_one ladder is exactly
 * what will drive this open again. So nothing here forecloses it: every incentive is read through
 * `incentivesOn()` and every note through `incentiveNote()`, both of which take a SOURCE rather
 * than an option. Adding `GroupLite.incentive` means teaching those two functions about a second
 * source and nothing else — no call site changes, no second spelling of the arithmetic.
 */

/** A discount as lib/promo wants it: a positive magnitude the caller stores as a negative line. */
export type DiscountLine = { label: string; exPennies: number; vatable: boolean };

/** …plus what it takes off the TOTAL, frozen, because a vatable discount moves the VAT too. */
export type ResolvedDiscount = DiscountLine & { grossOffPennies: number };

export const GROUP_SHAPES = ['base_plus_extras', 'pick_one'] as const;
export type GroupShape = (typeof GROUP_SHAPES)[number];
export const isGroupShape = (v: unknown): v is GroupShape =>
  (GROUP_SHAPES as readonly string[]).includes(String(v));

/**
 * ── THREE INCENTIVE SHAPES, BECAUSE THEY DO THREE DIFFERENT SUMS ────────────────────────────────
 * `amount_off`  REDUCES the bill by a figure somebody typed: "£50 off the water pump with the main
 *               quote". A negative line, and the total moves.
 *
 * `percent_off` REDUCES the bill by a figure somebody COMPUTED: "10% off the service while it is in
 *               for brakes". The percentage is the wording; the PENNIES are the promise. Resolved
 *               once, at freeze, per LINE and rounded per line, then summed into one negative line
 *               — so the arithmetic matches the lines the customer is looking at. Never recomputed
 *               afterwards: a document that re-derives its own discount at invoice time can print
 *               one number and bill another the moment a line, a rate or a rounding rule moves.
 *
 * `included`    GIVES something: "free diagnostic with gold". A line at zero, and the total does
 *               NOT move. Expressing it as a discount would drop the bill by the price of something
 *               that was never charged for.
 *
 * One mechanism for the three would have been tidier and wrong in two of them.
 */
export type Incentive =
  | { kind: 'amount_off'; label: string; exPennies: number; vatable: boolean; grossOffPennies: number }
  | {
      kind: 'percent_off'; label: string;
      /** The AUTHORING INPUT and the wording, in basis points: 1000 = 10%. Never the promise. */
      percentBp: number;
      /** THE PROMISE, resolved at freeze: per-line percentages, each rounded, then summed. */
      exPennies: number; vatable: boolean; grossOffPennies: number;
    }
  | { kind: 'included'; label: string };

export const INCENTIVE_KINDS = ['amount_off', 'percent_off', 'included'] as const;
/** The two that MOVE MONEY. The savings figure is these and only these — see savingsGrossPennies. */
export const MONEY_MOVING_INCENTIVES = ['amount_off', 'percent_off'] as const;
const movesMoney = (i: Incentive | null): i is Extract<Incentive, { grossOffPennies: number }> =>
  !!i && (MONEY_MOVING_INCENTIVES as readonly string[]).includes(i.kind);

export type GroupLite = {
  id: string;
  shape: GroupShape;
  title: string;
  position: number;
};

export type OptionLite = {
  id: string;
  groupId: string;
  /** base_plus_extras only. Exactly one member may carry it; none means the base is the main quote. */
  isBase: boolean;
  title: string;
  position: number;
  /** FROZEN at send. This module does display arithmetic on figures somebody else froze; it never
   *  recomputes them, because a second spelling of the totals is how two spellings disagree. */
  netPennies: number;
  vatPennies: number;
  grossPennies: number;
  incentive: Incentive | null;
};

/** The main quote as sent, excluding every option. See GROSS_PENNIES_MEANS below. */
export type MainLite = { netPennies: number; vatPennies: number; grossPennies: number };

/**
 * QuoteVersion.gross_pennies IS THE MAIN QUOTE ONLY — never the main quote plus some or all of the
 * options. A version with an open choice has no single total (see PrintedQuote.grandTotalPennies),
 * so the stored figure has to mean the one thing that is always true of it.
 */
export const GROSS_PENNIES_MEANS =
  'QuoteVersion.gross_pennies is the MAIN quote: the lines with no option, and nothing else.';

export const grossAgreesWithRule = (versionGrossPennies: number, main: MainLite): boolean =>
  versionGrossPennies === main.grossPennies;

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CANNOT BE SENT. Each refusal names the option or group, because this text reaches a garage
 * owner mid-edit and "invalid options" would send them hunting.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export function optionsRefusal(
  groups: readonly GroupLite[], options: readonly OptionLite[],
): string | null {
  const byGroup = new Map<string, OptionLite[]>();
  for (const g of groups) byGroup.set(g.id, []);
  for (const o of options) {
    if (!o.title?.trim()) return 'an option with no title cannot be chosen on a printed page';
    const bucket = byGroup.get(o.groupId);
    // An option whose group is not on the document can never be rendered OR chosen, so it is a
    // silent omission rather than a visible fault — which is the kind that ships.
    if (!bucket) return `“${o.title}” belongs to a group that is not on this quote`;
    bucket.push(o);
    if (o.grossPennies < 0) return `“${o.title}” has a negative price; a reduction is a discount, not an option`;
    const inc = o.incentive;
    if (inc) {
      if (!inc.label?.trim()) return `the incentive on “${o.title}” has no wording, and an unexplained discount on a quote is a question, not an offer`;
      if (inc.kind === 'percent_off') {
        if (!(inc.percentBp > 0)) return `the incentive on “${o.title}” is a percentage of nothing`;
        if (inc.percentBp >= 10000) return `the incentive on “${o.title}” takes 100% or more off, which is “included”, not a discount`;
      }
      if (movesMoney(inc)) {
        // A percentage that ROUNDS AWAY is the percent-specific trap: 1% of £2 is nothing, and
        // printing "1% off" beside a price that did not move is a promise the bill contradicts.
        if (!(inc.exPennies > 0)) {
          return inc.kind === 'percent_off'
            ? `the incentive on “${o.title}” rounds away to nothing at these prices, so the page would promise a saving the bill does not show`
            : `the incentive on “${o.title}” takes nothing off, so printing it would promise a saving of nothing`;
        }
        if (inc.grossOffPennies < inc.exPennies) return `the incentive on “${o.title}” takes more off the net than off the total, which no VAT treatment does`;
        if (!inc.vatable && inc.grossOffPennies !== inc.exPennies) {
          return `the incentive on “${o.title}” carries no VAT, so the saving off the total must equal the saving off the net`;
        }
        if (inc.grossOffPennies > o.grossPennies) return `the incentive on “${o.title}” takes more off than the option costs`;
      }
    }
  }

  for (const g of groups) {
    const members = byGroup.get(g.id) ?? [];
    if (!isGroupShape(g.shape)) return `“${g.title}” has no shape, so nothing knows whether its options are alternatives or add-ons`;
    if (!g.title?.trim()) return 'a group with no title gives the customer nothing to decide about';
    const bases = members.filter((m) => m.isBase);
    if (g.shape === 'pick_one') {
      // Two is the minimum that makes a CHOICE. One alternative is an add-on wearing the wrong shape.
      if (members.length < 2) return `“${g.title}” offers ${members.length === 1 ? `only “${members[0].title}”` : 'nothing'}; a choice needs at least two alternatives`;
      if (bases.length) return `“${bases[0].title}” is marked as a base inside “${g.title}”, which is a set of alternatives — nothing sits underneath them`;
    } else {
      if (bases.length > 1) return `“${g.title}” has ${bases.length} base jobs; the extras cannot hang off more than one`;
      // With a base, the extras are what the base is FOR. Without extras it is just an option.
      const extras = members.filter((m) => !m.isBase);
      if (!extras.length) return `“${g.title}” has no extras to add, so it is an option rather than a group`;
    }
  }

  const titles = options.map((o) => o.title.trim().toLowerCase());
  const dupe = titles.find((t, i) => titles.indexOf(t) !== i);
  if (dupe) return `two options are both called “${options.find((o) => o.title.trim().toLowerCase() === dupe)!.title}”, so a customer cannot say which they meant`;
  return null;
}

/** The members of each group, in document order, keyed by group id. */
export function groupMembers(
  groups: readonly GroupLite[], options: readonly OptionLite[],
): Map<string, OptionLite[]> {
  const m = new Map<string, OptionLite[]>();
  for (const g of [...groups].sort((a, b) => a.position - b.position)) {
    m.set(g.id, options.filter((o) => o.groupId === g.id).sort((a, b) => a.position - b.position));
  }
  return m;
}

export const baseOf = (members: readonly OptionLite[]): OptionLite | null =>
  members.find((m) => m.isBase) ?? null;

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A CUSTOMER SAID, AND WHAT IT RESOLVES TO
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * groupId → the option ids chosen in that group. ABSENT OR EMPTY IS A DECLINE, not an unanswered
 * question: groups are independent and none is a valid answer to each.
 */
export type Selection = { byGroup: Readonly<Record<string, readonly string[]>> };

export const emptySelection = (): Selection => ({ byGroup: {} });

export type Resolution = {
  chosen: OptionLite[];
  /** Positive magnitudes, for the caller to store as negative lines (lib/promo's convention). */
  discounts: ResolvedDiscount[];
  /** Things GIVEN. Stated as their own visible line, never folded into the savings figure, because
   *  a saving the invoice does not show is a figure that will not match it (owner, 2026-10-13). */
  includedLabels: string[];
  /** WHAT THEY SAVED: the money-moving incentives on what they chose, and nothing else. */
  savingsGrossPennies: number;
  /**
   * FROZEN FIGURES ADDED UP, FOR A SCREEN. Not the authority: the minted version's totals are
   * recomputed by lib/quote-totals over the resolved lines, because a vatable discount changes the
   * VAT and that recompute has one home.
   */
  displayGrossPennies: number;
};

/**
 * Resolves a selection. REFUSES rather than guesses: an acceptance is the act the job card, the
 * parts and the invoice all follow from, so a selection that does not make sense must never be
 * quietly narrowed into one that does.
 */
export function resolveSelection(
  main: MainLite, groups: readonly GroupLite[], options: readonly OptionLite[], sel: Selection,
): { ok: true; resolution: Resolution } | { ok: false; refusal: string } {
  const members = groupMembers(groups, options);
  const byId = new Map(options.map((o) => [o.id, o] as const));
  const STALE = 'That choice is no longer on this quote. Ask the garage to send it again.';

  // A group the selection NAMES that the document does not have is a stale page in front of the
  // customer, which is the same situation as a missing option and gets the same sentence.
  for (const [gid, ids] of Object.entries(sel.byGroup)) {
    if (!members.has(gid) && ids.length) return { ok: false, refusal: STALE };
  }

  const chosen: OptionLite[] = [];
  for (const [gid, mem] of members) {
    const g = groups.find((x) => x.id === gid)!;
    const ids = sel.byGroup[gid] ?? [];
    if (!ids.length) continue; // a decline, and a valid answer

    const seen = new Set<string>();
    const picked: OptionLite[] = [];
    for (const id of ids) {
      const o = byId.get(id);
      if (!o) return { ok: false, refusal: STALE };
      if (o.groupId !== gid) return { ok: false, refusal: `“${o.title}” is not one of the choices in “${g.title}”` };
      // Twice is ambiguous: a double-click, or a request for two. Neither is assumable.
      if (seen.has(id)) return { ok: false, refusal: `“${o.title}” was chosen twice` };
      seen.add(id);
      picked.push(o);
    }

    if (g.shape === 'pick_one') {
      if (picked.length > 1) {
        return { ok: false, refusal: `“${g.title}” is a choice of one, and ${picked.length} were chosen` };
      }
    } else {
      const base = baseOf(mem);
      // THE DEPENDENCY, AND THE WHOLE REASON THE GROUP HAS A SHAPE. An extra without its base is
      // an order for work that nothing is holding up — fitting pads on a car that is not in for
      // brakes. A group with NO base is the main quote's own extras, and the main quote is always
      // happening, so there is nothing to depend on.
      if (base && picked.some((p) => !p.isBase) && !picked.some((p) => p.isBase)) {
        return { ok: false, refusal: `the extras in “${g.title}” need “${base.title}” as well — they are only done while that is being done` };
      }
    }
    chosen.push(...picked);
  }

  chosen.sort((a, b) => a.position - b.position);
  const { discounts, includedLabels, savingsGrossPennies } = incentivesOn(chosen);
  const displayGrossPennies = main.grossPennies
    + chosen.reduce((a, o) => a + o.grossPennies, 0)
    - savingsGrossPennies;
  return { ok: true, resolution: { chosen, discounts, includedLabels, savingsGrossPennies, displayGrossPennies } };
}

/**
 * EVERY INCENTIVE IS READ HERE. Takes the SOURCES rather than options so a group-level incentive is
 * a second argument one day, not a second implementation (see the note at the top of this file).
 */
export function incentivesOn(sources: readonly { title: string; incentive: Incentive | null }[]): {
  discounts: ResolvedDiscount[]; includedLabels: string[]; savingsGrossPennies: number;
} {
  const discounts: ResolvedDiscount[] = [];
  const includedLabels: string[] = [];
  let savingsGrossPennies = 0;
  for (const s of sources) {
    const inc = s.incentive;
    if (!inc) continue;
    if (inc.kind === 'included') { includedLabels.push(inc.label); continue; }
    if (movesMoney(inc)) {
      discounts.push({ label: inc.label, exPennies: inc.exPennies, vatable: inc.vatable, grossOffPennies: inc.grossOffPennies });
      savingsGrossPennies += inc.grossOffPennies;
    }
  }
  return { discounts, includedLabels, savingsGrossPennies };
}

/**
 * RESOLVING A PERCENTAGE, ONCE. Per line, rounded per line, then summed — because the lines are
 * what the customer is looking at, and rounding the option total instead can differ by a penny or
 * two from the lines that explain it. The result is frozen onto the option; nothing recomputes it.
 */
export function resolvePercentOff(percentBp: number, linePennies: readonly number[]): number {
  return linePennies.reduce((a, p) => a + Math.round((p * percentBp) / 10000), 0);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE PRINTED PAGE SHOWS
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export type PrintedRow = {
  optionId: string; title: string; isBase: boolean;
  /** This option's own price, as frozen. */
  ownGrossPennies: number;
  /** The COMPLETE figure where one exists: for a pick_one alternative, and for an extra that hangs
   *  off the main quote, this is everything the customer would pay by choosing it and nothing else.
   *  NULL inside a base_plus_extras group that HAS a base, where "complete" depends on the base and
   *  on which other extras are ticked — a number there would be a different total for every reader. */
  completeGrossPennies: number | null;
  incentiveNote: string | null;
};

export type PrintedGroup = { groupId: string; title: string; shape: GroupShape; rows: PrintedRow[] };

export type PrintedQuote = {
  mainGrossPennies: number;
  groups: PrintedGroup[];
  /**
   * NULL whenever a choice is open. A document showing three mutually exclusive prices and one
   * grand total is the single most misreadable thing we could print, so the total belongs to the
   * choices and the page says what is still to decide.
   */
  grandTotalPennies: number | null;
  openChoices: string[];
};

export function printedQuote(
  main: MainLite, groups: readonly GroupLite[], options: readonly OptionLite[],
): PrintedQuote {
  const members = groupMembers(groups, options);
  const printed: PrintedGroup[] = [];
  const open: string[] = [];
  for (const [gid, mem] of members) {
    const g = groups.find((x) => x.id === gid)!;
    const hasBase = !!baseOf(mem);
    printed.push({
      groupId: gid, title: g.title, shape: g.shape,
      rows: mem.map((o) => ({
        optionId: o.id, title: o.title, isBase: o.isBase,
        ownGrossPennies: o.grossPennies,
        completeGrossPennies: g.shape === 'pick_one' || !hasBase
          ? main.grossPennies + o.grossPennies - grossOff(o)
          : null,
        incentiveNote: incentiveNote(o),
      })),
    });
    open.push(g.shape === 'pick_one' ? `which ${g.title.toLowerCase()}` : `what to add from “${g.title}”`);
  }
  return {
    mainGrossPennies: main.grossPennies,
    groups: printed,
    grandTotalPennies: open.length ? null : main.grossPennies,
    openChoices: open,
  };
}

/** What an incentive takes off the TOTAL, as frozen. Never the ex-VAT figure — that is the line. */
const grossOff = (s: { incentive: Incentive | null }): number =>
  movesMoney(s.incentive) ? s.incentive.grossOffPennies : 0;

/**
 * An UNTRIGGERED incentive prints as an offer and never as a number in any total; if it could
 * appear in a total the document would contradict itself depending on who read it. Takes a SOURCE,
 * so a group-level incentive renders through this same sentence (see the note at the top).
 */
export function incentiveNote(s: { incentive: Incentive | null }): string | null {
  const inc = s.incentive;
  if (!inc) return null;
  if (inc.kind === 'included') return `Includes ${inc.label}`;
  return `${inc.label} — already taken off the price shown`;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * ONE TRANSLATION FROM A STORED ROW
 *
 * Four call sites rebuilt the incentive from its columns by hand. A third shape makes that four
 * chances to forget one, and the site that forgot would print a quote missing a discount it had
 * promised. So the reconstruction lives beside the type it reconstructs. Loose input types, so this
 * module still has no database in it.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

export type IncentiveRow = {
  incentive_kind: string | null;
  incentive_label: string | null;
  incentive_ex_pennies: number | null;
  incentive_vatable: boolean | null;
  incentive_gross_off_pennies: number | null;
  incentive_percent_bp: number | null;
};

/**
 * REFUSES on a kind it does not know, rather than returning null. A null here would mean "no
 * incentive", so a row written by a newer build would render as a quote with the discount silently
 * missing — the customer reads a price that is not the offer. An unreadable stored shape is a
 * deployment problem and must say so out loud (lib/quote-options is the only reader).
 */
export function incentiveFromRow(r: IncentiveRow): Incentive | null {
  if (r.incentive_kind == null) return null;
  const label = r.incentive_label ?? '';
  switch (r.incentive_kind) {
    case 'included':
      return { kind: 'included', label };
    case 'amount_off':
      return { kind: 'amount_off', label, exPennies: r.incentive_ex_pennies ?? 0,
        vatable: !!r.incentive_vatable, grossOffPennies: r.incentive_gross_off_pennies ?? 0 };
    case 'percent_off':
      return { kind: 'percent_off', label, percentBp: r.incentive_percent_bp ?? 0,
        exPennies: r.incentive_ex_pennies ?? 0, vatable: !!r.incentive_vatable,
        grossOffPennies: r.incentive_gross_off_pennies ?? 0 };
    default:
      throw new Error(`UNKNOWN_INCENTIVE_KIND:${r.incentive_kind}`);
  }
}

export type OptionRow = IncentiveRow & {
  id: string; group_id: string | null; is_base: boolean; title: string; position: number;
  net_pennies: number; vat_pennies: number; gross_pennies: number;
};

/** A stored option as this module wants it. `group_id` is still nullable in the schema until the
 *  backfill is proved, and an option with no group cannot be rendered or chosen — so it is given
 *  its own id as a one-member group rather than being dropped, and optionsRefusal then names it. */
export function optionFromRow(r: OptionRow): OptionLite {
  return {
    id: r.id, groupId: r.group_id ?? `ungrouped:${r.id}`, isBase: !!r.is_base,
    title: r.title, position: r.position,
    netPennies: r.net_pennies, vatPennies: r.vat_pennies, grossPennies: r.gross_pennies,
    incentive: incentiveFromRow(r),
  };
}

export type GroupRow = { id: string; shape: string; title: string; position: number };

/** A stored group. The shape is validated by optionsRefusal, not here: this is a translation. */
export function groupFromRow(r: GroupRow): GroupLite {
  return { id: r.id, shape: r.shape as GroupShape, title: r.title, position: r.position };
}

/** A draft option as the authoring surface holds it — no frozen figures yet, so prices are the
 *  caller's to sum from the lines assigned to the option. */
export type DraftOptionRow = IncentiveRow & {
  id: string; group_id: string | null; is_base: boolean; title: string; position: number;
};
