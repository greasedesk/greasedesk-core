/**
 * File: lib/plan-hold.ts
 * THE EXACT PARAMETERS THAT HOLD A MOVE TO MONTHLY UNTIL RENEWAL, built where a gate can read them.
 *
 * ── WHY STRIPE HOLDS IT AND WE DO NOT ───────────────────────────────────────────────────────────
 * The alternative was a column of ours and a webhook applying it on renewal day. There is no
 * reliable "it is renewal day" event to act on — invoice.upcoming fires on the account's configured
 * lead time and is advisory — so a missed one charges the garage £750 for a year it asked not to
 * have, and the refund that follows is the exact outcome the paid-year lock exists to prevent. A
 * subscription schedule applies whether or not we are up.
 *
 * ── PHASE 1 IS THE PAID YEAR AND MUST COME OUT UNTOUCHED ────────────────────────────────────────
 * `subscriptionSchedules.create({ from_subscription })` lifts the live subscription into a schedule
 * whose single phase mirrors it. To append a second phase the first has to be sent BACK, and every
 * field not sent is reset to its default for that phase. So the echo is the dangerous part: drop
 * `automatic_tax` and the current year silently loses Stripe Tax; drop `discounts` and a coupon
 * still owed comes off.
 *
 * THIS REFUSES RATHER THAN DROPPING. Stripe's response phase and its update parameter carry the
 * same twenty field names, so anything non-empty that this does not know how to carry is named and
 * the hold is REFUSED — a garage told "try again" is recoverable; a paid year quietly re-billed on
 * different terms is not. `garageVatRegistered()` is false today, which is exactly why a silent
 * drop would wait until the day we register and then arrive as a tax bug.
 *
 * ── A LEAF MODULE ───────────────────────────────────────────────────────────────────────────────
 * `import type` only. The handler calls Stripe; the parameters are built here, pure, because an
 * assertion on a source scan would have passed on every day this file was wrong — that is exactly
 * how the missing coupon survived (see lib/plan-switch's header).
 */
import type Stripe from 'stripe';

const idOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : (v && typeof v === 'object' && typeof (v as any).id === 'string' ? (v as any).id : null);

/**
 * The fields of a schedule phase this module knows how to send back. Everything Stripe's RESPONSE
 * phase can carry is listed in one of the two sets below, so a field added to the API lands in
 * neither and is refused by name rather than dropped.
 */
export const CARRIED_PHASE_FIELDS = [
  'items', 'start_date', 'end_date', 'currency', 'discounts', 'metadata',
  'collection_method', 'default_payment_method', 'default_tax_rates', 'automatic_tax',
  // Sent explicitly rather than echoed — see the builder.
  'proration_behavior',
] as const;

/**
 * Fields we have never set and would not know how to carry faithfully. Non-empty here = refuse.
 * NOT "ignore": each one changes what the garage is charged or how it is invoiced.
 *
 * This list does real work rather than documenting: a gate asserts that these two arrays TOGETHER
 * name every top-level field of Stripe's own response Phase, read out of the installed type
 * definitions. A field Stripe adds in a later version therefore appears in neither, the clause goes
 * red at upgrade time, and the decision about it is taken by a person instead of by a filter.
 */
export const REFUSED_PHASE_FIELDS = [
  'add_invoice_items', 'application_fee_percent', 'billing_cycle_anchor', 'billing_thresholds',
  'description', 'invoice_settings', 'on_behalf_of', 'transfer_data', 'trial_end',
] as const;

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

export type HoldRefusal = { ok: false; unknownFields: string[] };
export type HoldParams = { ok: true; params: Stripe.SubscriptionScheduleUpdateParams };

/**
 * WHAT WE SEND to turn a one-phase schedule into "this year as it stands, then monthly".
 *
 * Phase 2 carries `gd_plan: monthly` in its METADATA, which Stripe sets on the subscription when
 * the phase begins. That is the whole reason no record of our own is needed: the existing webhook
 * path reads gd_plan off the subscription and appends the terms row itself, on the day it becomes
 * true rather than fourteen days early. A row written now would make the licences screen say
 * "monthly" while the garage is still on the yearly plan — the lie rehearsal D1 found.
 *
 * `end_behavior: 'release'` and `iterations: 1`: once the first monthly period is done the schedule
 * lets go, and what is left is an ordinary monthly subscription that every other path in this
 * codebase already understands. A schedule left attached would keep refusing subscriptions.update.
 *
 * NO DISCOUNTS on phase 2. The first-year coupon is `duration: 'once'` and was spent on the year
 * being paid for; carrying it forward would discount a £75 month by £300.
 */
export function monthlyAtRenewalUpdate(a: {
  /** phases[0] of the schedule that from_subscription just created. */
  phase: Record<string, unknown>;
  monthlyPriceId: string;
  quantity: number;
}): HoldParams | HoldRefusal {
  const p = a.phase;
  const unknown = Object.keys(p).filter((k) => {
    if (isEmpty(p[k])) return false;                       // absent is not a field to carry
    if ((CARRIED_PHASE_FIELDS as readonly string[]).includes(k)) return false;
    return true;                                            // REFUSED_PHASE_FIELDS land here, as does anything new
  });
  if (unknown.length) return { ok: false, unknownFields: unknown.sort() };

  const items = (p.items as any[] | undefined ?? []).map((i) => ({
    price: idOf(i.price) as string,
    quantity: i.quantity ?? 1,
    ...(Array.isArray(i.tax_rates) && i.tax_rates.length ? { tax_rates: i.tax_rates.map(idOf) as string[] } : {}),
    ...(Array.isArray(i.discounts) && i.discounts.length
      ? { discounts: i.discounts.map((d: any) => ({ coupon: idOf(d.coupon) ?? undefined, discount: idOf(d.discount) ?? undefined, promotion_code: idOf(d.promotion_code) ?? undefined })) }
      : {}),
    ...(i.metadata && Object.keys(i.metadata).length ? { metadata: i.metadata } : {}),
  }));

  const at: any = p.automatic_tax;
  const phase1: Record<string, unknown> = {
    items,
    start_date: p.start_date,
    end_date: p.end_date,
    // 'none' on the CURRENT phase: appending a future phase must not raise a proration on the year
    // already paid for. Stripe's default here is create_prorations, so this is a correction and not
    // a restatement — the one field deliberately not echoed.
    proration_behavior: 'none',
    ...(p.currency ? { currency: p.currency } : {}),
    ...(Array.isArray(p.discounts) && p.discounts.length
      ? { discounts: (p.discounts as any[]).map((d) => ({ coupon: idOf(d.coupon) ?? undefined, discount: idOf(d.discount) ?? undefined, promotion_code: idOf(d.promotion_code) ?? undefined })) }
      : {}),
    ...(p.metadata && Object.keys(p.metadata as object).length ? { metadata: p.metadata } : {}),
    ...(p.collection_method ? { collection_method: p.collection_method } : {}),
    ...(p.default_payment_method ? { default_payment_method: idOf(p.default_payment_method) } : {}),
    ...(Array.isArray(p.default_tax_rates) && p.default_tax_rates.length
      ? { default_tax_rates: (p.default_tax_rates as any[]).map(idOf) } : {}),
    ...(at && !isEmpty(at)
      ? { automatic_tax: { enabled: !!at.enabled, ...(at.liability?.type ? { liability: { type: at.liability.type, ...(idOf(at.liability.account) ? { account: idOf(at.liability.account) } : {}) } } : {}) } }
      : {}),
  };

  return {
    ok: true,
    params: {
      end_behavior: 'release',
      phases: [
        phase1 as any,
        {
          items: [{ price: a.monthlyPriceId, quantity: a.quantity }],
          iterations: 1,
          proration_behavior: 'none',
          metadata: { gd_plan: 'monthly' },
        } as any,
      ],
    } as Stripe.SubscriptionScheduleUpdateParams,
  };
}

/**
 * DID PHASE 1 COME BACK AS IT WENT IN? Read off the schedule Stripe returns and compared with the
 * subscription as it was before the hold.
 *
 * Why this is worth a second call: updating a schedule's CURRENT phase applies to the live
 * subscription, so a phase-1 echo that moved `end_date` would shorten the year the garage has paid
 * for. The refusal above stops a field being dropped; this catches the echo being wrong in a field
 * we do carry.
 *
 * THERE IS NO AUTOMATIC REPAIR, deliberately. Releasing the schedule detaches it and leaves the
 * subscription exactly as the bad update left it, so "release and we are back" is false. An
 * automatic correcting write to a subscription whose state we have just proved we do not
 * understand is worse than a refusal a person reads. The caller's job is to shout and stop.
 */
export function holdFidelity(a: {
  before: { priceIds: string[]; totalQuantity: number; periodEnd: number | null };
  phase: Record<string, unknown>;
}): { ok: boolean; differences: string[] } {
  const items = (a.phase.items as any[] | undefined) ?? [];
  const priceIds = items.map((i) => idOf(i.price)).filter((x): x is string => !!x).sort();
  const totalQuantity = items.reduce((n, i) => n + (i.quantity ?? 1), 0);
  const endDate = (a.phase.end_date as number | null | undefined) ?? null;

  const differences: string[] = [];
  const wantPrices = [...a.before.priceIds].sort();
  if (priceIds.join(',') !== wantPrices.join(',')) differences.push(`price ${priceIds.join('+') || '(none)'} ≠ ${wantPrices.join('+') || '(none)'}`);
  if (totalQuantity !== a.before.totalQuantity) differences.push(`quantity ${totalQuantity} ≠ ${a.before.totalQuantity}`);
  // The paid year's end. Compared only when we knew it: an unknown before cannot be said to differ.
  if (a.before.periodEnd !== null && endDate !== a.before.periodEnd) {
    differences.push(`period end ${endDate ?? 'null'} ≠ ${a.before.periodEnd}`);
  }
  return { ok: differences.length === 0, differences };
}
