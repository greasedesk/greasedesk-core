/**
 * File: lib/connect-webhook-contract.ts
 * What we require of a Connect event, and which events we claim to handle.
 *
 * Separate from the route so a gate can import the contract without importing a Next API handler,
 * and so the two things that must agree — the switch and the dashboard subscription — have one
 * written-down side to compare against.
 */
import type Stripe from 'stripe';

/**
 * THE EVENTS THIS ENDPOINT HANDLES. Kept in step with the switch in pages/api/stripe/connect-webhook.
 *
 * The drift gate asserts the endpoint's `enabled_events` is a SUPERSET of this. Superset, not equal:
 * subscribing to more than we handle costs a no-op, subscribing to less loses money silently — which
 * is exactly what happened between 15 and 16 August 2026, when `payment_intent.*` was absent and a
 * real £50 payment was never fulfilled.
 */
export const CONNECT_HANDLED_EVENTS = [
  'account.updated',
  'account.application.deauthorized',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'refund.created',
  'payout.paid',
  'payout.failed',
] as const;

export type ConnectHandledEvent = typeof CONNECT_HANDLED_EVENTS[number];

export const WEBHOOK_CONTRACT_ERROR = {
  MISSING_ACCOUNT: 'WEBHOOK_MISSING_ACCOUNT',
} as const;
export type WebhookContractCode = typeof WEBHOOK_CONTRACT_ERROR[keyof typeof WEBHOOK_CONTRACT_ERROR];

export class WebhookContractError extends Error {
  readonly code: WebhookContractCode;
  constructor(code: WebhookContractCode, message: string) {
    super(message);
    this.name = 'WebhookContractError';
    this.code = code;
  }
}

/** Duck-typed, for the same reason isStripeError and isCommissionError are. */
export const isWebhookContractError = (e: unknown, code?: WebhookContractCode): boolean => {
  const c = (e as { code?: unknown })?.code;
  if (typeof c !== 'string' || !c.startsWith('WEBHOOK_')) return false;
  return code ? c === code : true;
};

/**
 * THE CONNECTED ACCOUNT, OR NOTHING.
 *
 * Previously `event.account ?? ''`. An empty account id does not fail — it makes the subsequent
 * Stripe call in the PLATFORM context, where it looks up a garage's charge among our own and
 * truthfully finds nothing. The worst available answer: a wrong question, confidently answered.
 *
 * A Connect event without `account` means something is wrong upstream, and the only honest response
 * is to go red. Throwing here reaches the route's catch, which deletes the StripeEvent row and
 * returns 500 — so Stripe RETRIES rather than the event being silently mishandled and marked done.
 * Same principle as "unproven, not skipped" on the drift gate: when the code cannot know, it fails.
 */
export function requireConnectAccount(event: Pick<Stripe.Event, 'account' | 'id' | 'type'>): string {
  const acct = event.account;
  if (typeof acct === 'string' && acct.length > 0) return acct;
  throw new WebhookContractError(
    WEBHOOK_CONTRACT_ERROR.MISSING_ACCOUNT,
    `Connect event ${event.id} (${event.type}) carries no account — refusing to act in the platform context`,
  );
}
