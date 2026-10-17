/**
 * File: lib/catalogue-sets.ts
 * NAMED SETS OF CATALOGUE ITEMS — the rules, and what a set becomes when it reaches a quote.
 *
 * ── WHY SETS EXIST AT ALL ───────────────────────────────────────────────────────────────────────
 * An option can only hold lines ALREADY ON THE ESTIMATE. So "offer alternatives" on a Bronze
 * service could only ever offer Bronze again: Silver, Gold and Platinum are catalogue rows the
 * builder has no way to reach. Sets do not make the upsell ladder faster — they make it possible.
 *
 * ── THE SET KNOWS ITS OWN SHAPE, IN THE QUOTE'S OWN WORDS ───────────────────────────────────────
 * Oil Services is ordered and exclusive; the other service items are a menu any number can be
 * taken from. Those are not new concepts: they are `pick_one` and `base_plus_extras`, which
 * lib/quote-options already defines and QuoteOptionGroupDraft already stores. This module imports
 * that vocabulary rather than restating it, so a set and the group it produces cannot disagree
 * about what the customer was offered.
 */
import { GROUP_SHAPES, isGroupShape, type GroupShape } from '@/lib/quote-options';
import { resolveTierPrice, tierOffers, tierPricePounds, type TierAvailabilityName } from '@/lib/catalogue';

export { GROUP_SHAPES, isGroupShape };
export type SetShape = GroupShape;

export const SET_NAME_MAX = 80;

export type SetRefusal = { code: string; message: string };

/**
 * A set must be NAMED and SHAPED. Both are refusals rather than defaults: a set with no name is
 * unfindable on the Products screen, and a defaulted shape would quietly decide whether choosing
 * one item excludes the others — the single most consequential thing a set says.
 */
export function refuseSet(input: { name?: unknown; shape?: unknown }): SetRefusal | null {
  const name = String(input.name ?? '').trim();
  if (!name) return { code: 'name_required', message: 'A set needs a name — it is how you find it again.' };
  if (name.length > SET_NAME_MAX) return { code: 'name_too_long', message: `A set name is at most ${SET_NAME_MAX} characters.` };
  if (!isGroupShape(input.shape)) {
    return { code: 'shape_unknown', message: `A set is either “${GROUP_SHAPES.join('” or “')}”. Choosing one decides whether taking an item excludes the others.` };
  }
  return null;
}

/**
 * AT MOST ONE LADDER PER ITEM — the same rule the database enforces with a trigger, said here so
 * the screen can refuse in words before the write does in an error code.
 *
 * THIS IS NOT THE GUARANTEE. The trigger is. A check here races any other writer and would pass
 * the instant two people add the same item to two ladders at once; it exists so the common case
 * reads as a sentence rather than as a unique-violation. Never remove the trigger because this
 * exists — see the schema note on CatalogueSetMember.
 */
export function refuseMembership(args: {
  shape: SetShape;
  /** The pick_one sets this item is ALREADY in, excluding the one being written to. */
  otherLadderNames: readonly string[];
}): SetRefusal | null {
  if (args.shape !== 'pick_one' || args.otherLadderNames.length === 0) return null;
  return {
    code: 'already_in_a_ladder',
    message: `This product is already a choice in “${args.otherLadderNames[0]}”. An item can sit in one set of alternatives, because dropping the ladder icon has to know which ladder to offer.`,
  };
}

// ── WHAT A SET OFFERS A PARTICULAR CAR ──────────────────────────────────────────────────────────

export type SetMemberInput = {
  catalogueItemId: string;
  position: number;
  title: string;
  basePriceExVat: number;
  vatRate: number;
  labourHours: number | null;
  /** TierAvailabilityName, not `string`. A widened type here would have let a caller pass any
   *  word through to resolveTierPrice, where an unrecognised one falls through to the price —
   *  which is the not_applicable bug coming back by the side door. tsc caught it. */
  tierPrices: Array<{ tierId: string; priceExVat: number | null; availability?: TierAvailabilityName | null }>;
};

export type Rung = {
  catalogueItemId: string;
  title: string;
  /** NULL means "offered, priced on the day" — the estimator types it. Never a stand-in for 0. */
  pricePounds: number | null;
  vatRate: number;
  labourHours: number | null;
};

/**
 * The rungs to offer, in the set's own order, for a car on a given tier.
 *
 * ── EVERY RUNG, NOT ONLY THE DEARER ONES ───────────────────────────────────────────────────────
 * Owner's instruction, and worth stating because the opposite is the intuitive thing to build: a
 * customer moving DOWN from Gold to Silver is still a sale, and a ladder that only ever points
 * upwards turns a hesitation into a walk-out. The order is the set's; the direction is nobody's.
 *
 * ── A not_applicable RUNG DISAPPEARS ───────────────────────────────────────────────────────────
 * It is not greyed out. "An EV cannot have an oil service, so a greyed rung explains my catalogue
 * rather than telling the customer anything useful. Greying out is for things they could have and
 * cannot right now" (owner, 2026-10-17).
 */
export function rungsFor(members: readonly SetMemberInput[], tierId: string | null): Rung[] {
  return [...members]
    .sort((a, b) => a.position - b.position || a.catalogueItemId.localeCompare(b.catalogueItemId))
    .flatMap((m) => {
      const r = resolveTierPrice(m.basePriceExVat, m.tierPrices, tierId);
      if (!tierOffers(r)) return [];
      return [{
        catalogueItemId: m.catalogueItemId,
        title: m.title,
        pricePounds: tierPricePounds(r),
        vatRate: m.vatRate,
        labourHours: m.labourHours,
      }];
    });
}

/**
 * THE LADDER A LINE CAN OFFER, given the catalogue item that priced it.
 *
 * Returns null when the item is in no pick_one set — the builder then falls back to the empty
 * two-option group it has always made, which is still the right answer for a hand-typed line.
 */
export function ladderForItem<T extends { id: string; shape: string; members: readonly SetMemberInput[] }>(
  sets: readonly T[],
  catalogueItemId: string | null | undefined,
): T | null {
  if (!catalogueItemId) return null;
  return sets.find((s) => s.shape === 'pick_one' && s.members.some((m) => m.catalogueItemId === catalogueItemId)) ?? null;
}

/** The menus an item sits in — any number, unlike ladders. Used by the extras icon. */
export function menusForItem<T extends { id: string; shape: string; members: readonly SetMemberInput[] }>(
  sets: readonly T[],
  catalogueItemId: string | null | undefined,
): T[] {
  if (!catalogueItemId) return [];
  return sets.filter((s) => s.shape === 'base_plus_extras' && s.members.some((m) => m.catalogueItemId === catalogueItemId));
}
