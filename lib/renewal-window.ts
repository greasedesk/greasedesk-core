/**
 * File: lib/renewal-window.ts
 * THE LAST FOURTEEN DAYS BEFORE RENEWAL — the one window in which a garage that has PAID for a
 * year may choose monthly, taking effect AT RENEWAL (owner ruling, 2026-10-29).
 *
 * ── WHY A WINDOW AND NOT A BUTTON ───────────────────────────────────────────────────────────────
 * A paid year is never cut short and never refunded; lib/billing-plans' annualPaidIn closes the
 * switch the moment money is taken. That left no door at all, so a garage wanting monthly next
 * year had to write to us and be remembered. The window is the door: inside it the choice is about
 * the NEXT period, which nobody has paid for, so it moves no money.
 *
 * ── ONE RULE, TWO READERS ───────────────────────────────────────────────────────────────────────
 * The licences screen decides what to show and change-plan decides what to allow. Both call this,
 * so a screen that offers the switch and an endpoint that refuses it cannot disagree — the failure
 * that annualPaidIn was written to prevent, one rule further on.
 *
 * ── A LEAF MODULE ───────────────────────────────────────────────────────────────────────────────
 * No db, no Stripe client, `import type` only, so the screen may call it from either side of the
 * bundle and a gate may assert the arithmetic without a key.
 */
import type Stripe from 'stripe';

/** Fourteen days, as a NAMED constant: the clauses derive the boundary from it rather than
 *  restating 14 in their own arithmetic, so moving this number moves the gate with it. */
export const WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export type SwitchWindow = {
  /** True only inside [renewalAt − WINDOW_DAYS, renewalAt). */
  open: boolean;
  /** The moment the window opens, or null when the renewal date is unknown. */
  opensAt: Date | null;
};

/**
 * Is the window open?
 *
 * THREE STATES, not two. A null renewalAt is UNKNOWN — a subscription we could not read, or one
 * carrying no period — and unknown is closed, with no date to show. It is not "open because we
 * cannot prove it is shut": that would offer a switch whose effective date we could not name.
 *
 * HALF-OPEN at the top end. At renewalAt itself the window is shut: that instant belongs to the
 * next period, and a switch landing exactly then is a switch to a year already being charged for.
 */
export function monthlySwitchWindow(a: { renewalAt: Date | null | undefined; now: Date }): SwitchWindow {
  if (!a.renewalAt) return { open: false, opensAt: null };
  const opensAt = new Date(a.renewalAt.getTime() - WINDOW_DAYS * DAY_MS);
  return { open: a.now.getTime() >= opensAt.getTime() && a.now.getTime() < a.renewalAt.getTime(), opensAt };
}

/**
 * THE RENEWAL DATE THE WINDOW IS MEASURED FROM — one resolution, used by the screen and by
 * change-plan, so the two cannot reach different answers from the same facts.
 *
 * LIVE FIRST. Stripe's own object is the truth; the cached GroupBilling.current_period_end is a
 * projection that is at best a webhook behind. The cache is the FALLBACK so that a Stripe outage
 * costs the pending state rather than the whole screen.
 *
 * A CACHED DATE IN THE PAST IS NOT A RENEWAL DATE. It is the END of a period that has already
 * rolled, left behind because no webhook landed. Trusting it would open the window permanently
 * for a garage whose cache went quiet — the switch offered on a date that passed. The live answer
 * is NOT filtered this way: if Stripe says the period ended yesterday, that is the fact, and the
 * half-open rule in monthlySwitchWindow already treats it as shut.
 */
export function renewalAtFor(a: {
  live: Date | null | undefined;
  cached: Date | null | undefined;
  now: Date;
}): Date | null {
  if (a.live) return a.live;
  if (a.cached && a.cached.getTime() > a.now.getTime()) return a.cached;
  return null;
}

/**
 * HAS A MOVE TO MONTHLY ALREADY BEEN HELD? Read from Stripe's own object rather than mirrored into
 * a column of ours: a pending state we copied is a thing that can go stale and lie, and the
 * licences screen telling a garage it was still on the yearly plan after it had switched is the
 * fault this whole afternoon came out of.
 *
 * `subscription.schedule` is the id of the schedule managing it, or null. We attach a schedule for
 * exactly one reason, so its presence IS the pending move — stated here because that equivalence
 * is an assumption about our own usage, not a fact about Stripe. If a schedule is ever attached
 * for a second reason, this becomes wrong and the screen starts describing the wrong thing.
 */
export function pendingScheduleId(sub: Pick<Stripe.Subscription, 'schedule'> | null | undefined): string | null {
  const s = sub?.schedule as string | { id: string } | null | undefined;
  return typeof s === 'string' ? s : s?.id ?? null;
}
