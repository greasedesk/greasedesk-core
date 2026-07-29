/**
 * File: lib/stripe.ts
 * THE one server-side Stripe client (item-12). SANDBOX ONLY until live keys are deliberately added.
 * Env-gated: no STRIPE_SECRET_KEY → getStripe() returns null and every billing surface stays dormant
 * (the OCR-shadow pattern — the feature activates the moment its key lands in Vercel, no redeploy of
 * logic). Credentials are server-only; never shipped to the client.
 *
 * Env (Vercel, sensitive OFF per standing rule):
 *   STRIPE_SECRET_KEY        — sk_test_… (sandbox)
 *   STRIPE_WEBHOOK_SECRET    — whsec_… (from the webhook endpoint config)
 *   STRIPE_PRICE_ID          — the £75/mo GBP recurring Price (licensed, per-site quantity)
 *   STRIPE_PRICE_USD         — the $100/mo USD recurring Price (same product)
 *   STRIPE_PRICE_EUR         — the €90/mo EUR recurring Price (same product)
 *   NEXT_PUBLIC_APP_URL      — base URL for Checkout success/cancel + Portal return (defaults greasedesk.com)
 *
 * Price amounts are the COUNTRY PROFILE's monthlyPrice, exclusive of tax — checkout verifies the
 * selected Price's amount+currency against the profile before creating a session.
 */
import Stripe from 'stripe';

let _stripe: Stripe | null | undefined;

/** The client, or null when unconfigured (dormant). Pinned API version for stable webhook shapes. */
export function getStripe(): Stripe | null {
  if (_stripe !== undefined) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  _stripe = key ? new Stripe(key, { apiVersion: '2025-03-31.basil' as any }) : null;
  if (!key) console.warn('[stripe] not configured — billing dormant (STRIPE_SECRET_KEY absent)');
  return _stripe;
}

export const stripeConfigured = (): boolean => !!process.env.STRIPE_SECRET_KEY;
export const stripePriceId = (): string | null => process.env.STRIPE_PRICE_ID ?? null;

/** The recurring Price for a tenant's currency (country profile → currency → env). NULL when that
 *  currency's Price isn't configured yet — checkout REFUSES rather than falling back to another
 *  currency, so a US tenant can never be shown $100 and charged a GBP Price. */
export function stripePriceIdForCurrency(currency: string): string | null {
  switch (currency.toUpperCase()) {
    case 'GBP': return process.env.STRIPE_PRICE_ID ?? null;
    case 'USD': return process.env.STRIPE_PRICE_USD ?? null;
    case 'EUR': return process.env.STRIPE_PRICE_EUR ?? null;
    default: return null;
  }
}
export const stripeWebhookSecret = (): string | null => process.env.STRIPE_WEBHOOK_SECRET ?? null;
export const appBaseUrl = (): string => process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://greasedesk.com';

/** THE trial length, single source (mirrors lib/trial TRIAL_DAYS). Stripe owns the clock once a
 *  subscription exists; this seeds trial_period_days at Checkout. */
export const TRIAL_PERIOD_DAYS = 60;
