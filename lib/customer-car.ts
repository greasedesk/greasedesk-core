/**
 * File: lib/customer-car.ts
 *
 * IS THIS A CUSTOMER'S CAR? — the one answer, for every surface that reads the fleet as people to
 * contact.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * The marketing board fetched every Vehicle in the group and treated each one as a customer's car,
 * because it was written before stock existed. Measured on the live tenant 2026-09-16: three of
 * twelve Hot leads were the garage's OWN cars with expired MOTs, so the number a garage reads as
 * "people worth ringing today" was wrong by a quarter, and the board was telling the owner to ring
 * himself. All five of that tenant's stock cars carried an MOT date, so all five were eligible; the
 * other two were absent only because their MOTs happened to be fine.
 *
 * The diary had the same shape (a stock card's £300 counted as revenue) and was fixed separately.
 * This is the second, and the argument for ONE rule rather than one per surface.
 *
 * ── THE QUESTION IS NOT "IS IT OURS" ────────────────────────────────────────────────────────────
 *
 * The first version of this file asked that, and the gate caught it: a SCRAPPED car is not ours and
 * is not a customer's either, so "not ours" put it straight back on the board. **Ours and a
 * customer's are not complements.** The question a fleet surface actually asks is the positive one —
 * is there a keeper here we might ring? — so that is the question this file answers, and the file is
 * named for it.
 *
 * A car is a customer's car unless it has ever entered stock and not left by being SOLD:
 *
 *   sold, traded_out   A CUSTOMER'S AGAIN. New keeper, whose MOT is genuinely their problem.
 *   scrapped           Never. There is no car.
 *   own_use            Never. A disposal — the car leaves the BOOK — but not the owner's hands,
 *                      which is exactly why vatPositionFor('own_use') returns `unsettled`. Omit
 *                      this and the car moved from the yard to the drive walks back onto the board
 *                      telling him to ring himself: the same bug, deferred by one action.
 *   returned           Never — and this is the one a later reader will want to "fix".
 *   (no disposal)      Never. It is in the yard right now.
 *
 * `returned` means returned to the SELLER. Somebody else owns it, so it looks like it qualifies —
 * and that is the trap. **Whether another party owns a car is not the question.** The question is
 * whether they are someone this garage would ring about an MOT, and a trade vendor is not. Ruled
 * 2026-09-16. If you are here because a returned car is missing from the board, that is this rule
 * working; change it on the owner's say-so, never on the reasoning that it has an owner.
 *
 * NOT gated on the ownership edge, for a second and measured reason: the edge is unreliable for
 * exactly this population. On the live tenant, KT06FBX — a car in stock — carries a current edge to
 * a Customer row literally named **"Stock"** (no phone, no email): a workaround somebody built
 * before stock existed. "Has an owner" would have let that car straight back on. The row is
 * deliberately left alone — the owner will decide about it separately — and this rule makes it
 * inert, because the car it points at is excluded by its StockItem whatever the edge says. Anyone
 * finding that row later should read it as pre-stock residue, not as live data.
 *
 * ── TWO EXPORTS THAT MUST AGREE ─────────────────────────────────────────────────────────────────
 *
 * `CUSTOMER_CARS` is a Prisma `where` fragment, so a fleet read excludes at the QUERY and never
 * loads the rows — the board ran 15.8s once, and query depth is the latency currency on lhr1 → Neon
 * eu-west-2. `isCustomerCar` is the same rule over rows already in memory.
 *
 * Two rules hoping to stay in step is the thing being fixed, so `customer-car-gate` asserts THE TWO
 * AGREE over a fixture set covering every disposal kind — not that each is separately plausible. Add
 * a kind and the coverage clause fails until both halves of the rule know about it.
 */

/** The only ways out of stock that hand the car to someone worth ringing. Everything else — including
 *  not having left at all — means this is not a customer's car. */
export const LEAD_AGAIN_KINDS = ['sold', 'traded_out'] as const;

type StockItemShape = { disposal?: { kind: string } | null };

/** Did this stock item hand the car to a customer? Undisposed = no; any kind outside the list = no. */
const handedOver = (i: StockItemShape): boolean =>
  !!i.disposal && (LEAD_AGAIN_KINDS as readonly string[]).includes(i.disposal.kind);

/**
 * A CUSTOMER'S CAR, over rows already loaded. `stockItems` absent or empty = never stock = yes,
 * which is the overwhelming majority and the reason absence must mean that.
 *
 * A car can carry SEVERAL items — a re-acquisition is a new row, never an undo — so one item that
 * did not hand the car over is enough to disqualify it, however many earlier sales there were.
 */
export function isCustomerCar(v: { stockItems?: StockItemShape[] | null }): boolean {
  return !(v.stockItems ?? []).some((i) => !handedOver(i));
}

/**
 * CUSTOMER CARS ONLY, as a Prisma `where` fragment on Vehicle. `none` over the negation of
 * `handedOver`; a vehicle with no stock items satisfies `none` vacuously, which is the correct
 * answer for a customer's car and matches `isCustomerCar` returning true on an empty list.
 */
export const CUSTOMER_CARS = {
  stockItems: {
    none: {
      OR: [
        { disposal: { is: null } },
        { disposal: { is: { kind: { notIn: [...LEAD_AGAIN_KINDS] } } } },
      ],
    },
  },
};
// NOT `as const`: Prisma's generated WhereInput wants mutable arrays, and a readonly tuple will not
// assign. Deliberately NOT typed as Prisma.VehicleWhereInput either — this module's other export is
// read by the marketing PAGE, and a db-reaching import here, even a type-only one, is the shape that
// has shipped Prisma to the browser before. This file stays a leaf.

/** What the fleet tile says, because a denominator that counts cars the numerator cannot is
 *  arithmetic that stops adding up. */
export const FLEET_EXCLUDES_STOCK = 'Cars we own are not counted — they are stock, not customers.';
