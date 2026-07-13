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
 */
import type { BillingStatus } from '@prisma/client';

export type BillingGate = {
  subscriptionStatus: string | null; // raw Stripe status cache
  status: BillingStatus | null;       // our coarse projection (display)
};

// Stripe subscription.status → the gate. trialing/active = full; past_due = grace (Stripe retrying,
// still allowed); canceled/unpaid/incomplete_expired/paused = lapsed (read-only forever).
const LAPSED = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
const GRACE = new Set(['past_due']);

/** May this tenant create new work? TRUE unless Stripe has explicitly lapsed the subscription. */
export function canWrite(gate: BillingGate | null | undefined): boolean {
  const s = gate?.subscriptionStatus;
  if (!s) return true; // no subscription cache yet → allowed (trial / pre-Stripe / dormant)
  return !LAPSED.has(s);
}

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
