/**
 * File: lib/billing.ts
 * THE billing gate (item-12) — the ONE place "may this tenant write?" is decided. Never inline,
 * never scattered (same discipline as admin-guard / permissions). Reads the webhook-maintained
 * subscription_status cache (a mirror of Stripe's truth kept fresh by verified webhooks) — it does
 * NOT call Stripe on the request path.
 *
 * THE RULING (2026-07-13), built to literally:
 *   Reads stay open FOREVER, FREE — login, dashboard, diary view, invoice docs, PDFs, exports.
 *   Writes block only when LAPSED. Nothing is ever deleted. A garage's invoices are statutory
 *   records (HMRC: six years). "You keep everything, you just can't add to it."
 *
 * SAFE-BY-DEFAULT: a tenant with no Stripe subscription yet (trial before Checkout, or every
 * existing tenant before billing is wired) is ALLOWED. The gate bites ONLY when Stripe has
 * explicitly said canceled/unpaid — so wiring this can never lock a live tenant out by omission.
 *
 * ── FOUR PHASES (2026-08-06) ────────────────────────────────────────────────────────────────────
 *   ok         — trialing/active, or no subscription at all. Everything open.
 *   grace      — the money hasn't arrived, but the clock hasn't run out. FULL functionality, plus a
 *                red countdown. Seven days from the anchor.
 *   restricted — the clock ran out. NO NEW BOOKINGS. Everything else stays open: quoting, adding a
 *                part to a car already on the ramp, completing stages, and ISSUING THE INVOICE for
 *                work already done. A garage must always be able to finish and bill what is in the
 *                workshop, and to take a new enquiry.
 *   lapsed     — Stripe says canceled/unpaid/paused. Read-only.
 *
 * "NO NEW JOB CARDS" MEANS NO NEW BOOKINGS, NOT NO NEW ROWS (ruling 2026-08-06). A card created
 * from the quote entry point carries no resource and no start time — it occupies nothing and costs
 * nothing. The gate therefore lives at lib/diary-booking's placeJobCard, the one chokepoint for
 * taking a workshop slot, which is what the subscription actually buys. A restricted tenant
 * accumulating quote cards is pipeline for when they pay.
 */
import type { BillingStatus } from '@prisma/client';

export type BillingGate = {
  subscriptionStatus: string | null; // raw Stripe status cache
  status: BillingStatus | null;       // our coarse projection (display)
  graceStartedAt?: Date | string | null;
  graceReason?: string | null;
};

export type BillingPhase = 'ok' | 'grace' | 'restricted' | 'lapsed';
export type GraceReason = 'trial_ended' | 'payment_failed';

/** The window, in days. A constant, not a column — changing it must not need a migration. */
export const GRACE_DAYS = 7;

// Stripe subscription.status → the gate. trialing/active = full; past_due = grace (Stripe retrying,
// still allowed); canceled/unpaid/incomplete_expired/paused = lapsed (read-only forever).
const LAPSED = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
const GRACE = new Set(['past_due']);

/**
 * THE resolver. Every guard, the banner and the tests read this and nothing else.
 *
 * Grace ends at the EARLIER of seven days and Stripe reaching a lapsed status — the lapsed branch
 * is tested first, so a subscription Stripe cancels on day three degrades straight to `lapsed` and
 * the banner never shows "4 days left" over a 402.
 *
 * The converse matters just as much: when OUR clock runs out at day seven while Stripe is still
 * retrying, the phase is `restricted`, NOT `lapsed`. Stripe may yet collect. The wording must say
 * the payment hasn't arrived, never that the subscription has ended.
 */
export function billingGate(gate: BillingGate | null | undefined, now: Date = new Date()): {
  phase: BillingPhase; graceEndsAt: Date | null; daysLeft: number | null; reason: GraceReason | null;
} {
  const status = gate?.subscriptionStatus ?? null;
  const reason = (gate?.graceReason as GraceReason | null) ?? null;

  // Stripe's word first — it can cut the clock short, and it outranks our arithmetic.
  if (status && LAPSED.has(status)) return { phase: 'lapsed', graceEndsAt: null, daysLeft: null, reason };

  const anchorRaw = gate?.graceStartedAt ?? null;
  const anchor = anchorRaw ? new Date(anchorRaw) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) {
    return { phase: 'ok', graceEndsAt: null, daysLeft: null, reason: null };
  }

  const graceEndsAt = new Date(anchor.getTime() + GRACE_DAYS * 86_400_000);
  const msLeft = graceEndsAt.getTime() - now.getTime();
  if (msLeft <= 0) return { phase: 'restricted', graceEndsAt, daysLeft: 0, reason };
  // Round UP: with eight hours to run, "1 day left" is truer to the reader than "0".
  return { phase: 'grace', graceEndsAt, daysLeft: Math.ceil(msLeft / 86_400_000), reason };
}

/** May this tenant create new work? TRUE unless Stripe has explicitly lapsed the subscription.
 *  Scoped to NEW WORK ONLY — continuing work and billing are never gated by it (see the header). */
export function canWrite(gate: BillingGate | null | undefined): boolean {
  const s = gate?.subscriptionStatus;
  if (!s) return true; // no subscription cache yet → allowed (trial / pre-Stripe / dormant)
  return !LAPSED.has(s);
}

/** May this tenant take a workshop SLOT? False in restricted and lapsed. The one question
 *  placeJobCard asks. */
export function canBook(gate: BillingGate | null | undefined, now: Date = new Date()): boolean {
  const phase = billingGate(gate, now).phase;
  return phase === 'ok' || phase === 'grace';
}

/** The columns every caller must select, so nobody reads two of the four and resolves a wrong phase. */
export const BILLING_GATE_SELECT = {
  subscription_status: true, status: true, grace_started_at: true, grace_reason: true,
} as const;

/** DB row → the gate's shape. One mapper, so the snake/camel hop happens once. */
export const gateFromRow = (r: {
  subscription_status?: string | null; status?: BillingStatus | null;
  grace_started_at?: Date | null; grace_reason?: string | null;
} | null | undefined): BillingGate => ({
  subscriptionStatus: r?.subscription_status ?? null,
  status: r?.status ?? null,
  graceStartedAt: r?.grace_started_at ?? null,
  graceReason: r?.grace_reason ?? null,
});

/** The coarse BillingStatus projection from a raw Stripe status (for display + the enum column). */
export function billingStatusFromStripe(s: string | null | undefined): BillingStatus {
  if (!s) return 'ok';
  if (LAPSED.has(s)) return 'lapsed';
  if (GRACE.has(s)) return 'grace';
  return 'ok';
}

/** Is the tenant in the read-only lapsed state? (the loud, non-punitive UI branch) */
export function isLapsed(gate: BillingGate | null | undefined): boolean {
  return !!gate?.subscriptionStatus && LAPSED.has(gate.subscriptionStatus);
}

/** THE lapsed vocabulary, exported so no screen writes its own copy. There were three. */
export const isLapsedStatus = (s: string | null | undefined): boolean => !!s && LAPSED.has(s);
