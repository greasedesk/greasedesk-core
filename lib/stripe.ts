/**
 * File: lib/stripe.ts
 * THE one server-side Stripe client (item-12).
 * Env-gated: no STRIPE_SECRET_KEY → getStripe() returns null and every billing surface stays dormant
 * (the OCR-shadow pattern — the feature activates the moment its key lands in Vercel, no redeploy of
 * logic). Credentials are server-only; never shipped to the client.
 *
 * Env (Vercel, sensitive OFF per standing rule):
 *   STRIPE_SECRET_KEY        — the platform secret key. DO NOT INFER THE MODE FROM ITS PREFIX:
 *                              production runs on a RESTRICTED LIVE key (rk_live_…), which fails an
 *                              `sk_live_` test and reported "sandbox" about a live account. Every
 *                              Stripe object carries its own `livemode`; ask the object, not the
 *                              key. This comment said "sk_test_… (sandbox)" until 2026-08-13 and
 *                              was itself the source of a wrong claim about whether real money was
 *                              involved.
 *   STRIPE_PUBLISHABLE_KEY   — pk_… the platform publishable key. Required ONLY by the embedded
 *                              Connect components on /admin/payments; absent, that page still
 *                              renders the connection state and says the in-page view is off.
 *   STRIPE_WEBHOOK_SECRET    — whsec_… (from the webhook endpoint config)
 *   STRIPE_PRICE_ID          — THE one recurring Price (licensed, per-site quantity). Since
 *                              2026-08-09: GBP-ONLY, £75.00, TAX-INCLUSIVE, on product
 *                              prod_V2WiIjJUsLBzkC. Supersedes the multi-currency tax-EXCLUSIVE
 *                              price (GBP base + USD/EUR options) on prod_V1ZiRMQ7jAs6bc, now
 *                              renamed GreaseDesk_OLD.
 *   STRIPE_PRICE_CORE        — the SAME id. lib/modules maps a paid line item to the `core`
 *                              entitlement via `STRIPE_PRICE_CORE ?? STRIPE_PRICE_ID`, so a stale
 *                              CORE value silently WINS over a freshly-set PRICE_ID. The two must
 *                              always be changed together; that fallback is a trap, not a feature.
 *   NEXT_PUBLIC_APP_URL      — base URL for Checkout success/cancel + Portal return (defaults greasedesk.com)
 *
 * Price amounts are the COUNTRY PROFILE's monthlyPrice — checkout retrieves the Price (expand:
 * currency_options) and asserts BOTH the tenant-currency option's amount AND its tax_behavior
 * against what we display before creating a session. The amount alone is not enough: the old
 * exclusive price and the new inclusive one are both £75 in GBP and differ only in that field,
 * which is the difference between charging £75 and charging £90.
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
/**
 * The PLATFORM publishable key, needed by Stripe's embedded components in the browser.
 *
 * DELIBERATELY NOT `NEXT_PUBLIC_`. A publishable key is safe to expose, but a NEXT_PUBLIC_ value is
 * inlined at BUILD time — so it could not land without a redeploy, and the whole point of the
 * env-gating pattern in this file is that a surface activates the moment its key reaches Vercel.
 * It is handed to the client by an admin-authenticated endpoint instead, which costs nothing and
 * keeps the deployment story the same as every other Stripe surface here.
 */
export const stripePublishableKey = (): string | null => process.env.STRIPE_PUBLISHABLE_KEY ?? null;
export const stripePriceId = (): string | null => process.env.STRIPE_PRICE_ID ?? null;
export const stripeWebhookSecret = (): string | null => process.env.STRIPE_WEBHOOK_SECRET ?? null;
/**
 * WHICH MODE IS THIS KEY IN? Asked of Stripe, once, and cached for the process.
 *
 * There is no honest local way to know. The key prefix lies — production runs a restricted live key
 * (`rk_live_…`) that fails an `sk_live_` test — and the Account object, inconveniently, carries no
 * `livemode` at all. Balance does, so one cheap read answers it authoritatively.
 *
 * Returns null when Stripe is unconfigured or unreachable: unknown, never a guess. Callers that are
 * about to record which mode something belongs to must treat null as "don't claim".
 */
let _livemode: boolean | null | undefined;
export async function platformLivemode(): Promise<boolean | null> {
  if (_livemode !== undefined) return _livemode;
  const stripe = getStripe();
  if (!stripe) { _livemode = null; return _livemode; }
  try {
    const balance = await stripe.balance.retrieve();
    _livemode = balance.livemode;
  } catch (e: any) {
    console.error('[stripe] could not determine livemode', e?.message);
    _livemode = null;
  }
  return _livemode;
}

export const appBaseUrl = (): string => process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'https://greasedesk.com';

/** THE trial length, single source (mirrors lib/trial TRIAL_DAYS). Stripe owns the clock once a
 *  subscription exists; this seeds trial_period_days at Checkout. */
export const TRIAL_PERIOD_DAYS = 60;
