# Billing → Commission — test-mode acceptance runbook

The `invoice.paid` → accrual and `charge.refunded` → clawback wiring is **built and proven** with
synthetic Stripe-signed events (see `_billing_gate` results in the slice report). It is **dormant in
prod** until Stripe keys land (`getStripe()` returns null → the webhook 503s). This runbook is the
**real-Stripe test-mode acceptance** — the part that needs a Stripe *test* account, the Stripe CLI, and
test cards. It stays entirely in **test mode**; no live keys, no real charges. The live cutover with
real cards is a **separate later step**.

## Prerequisites
- A Stripe account in **test mode**. Keys: `sk_test_…`, and a webhook signing secret `whsec_…`.
- The **Stripe CLI** (`stripe login`) on your machine.
- A **test-mode Price** for the £35/mo GBP subscription; put its id in `STRIPE_PRICE_ID`.

## Where to point the webhook (keep prod dormant / the real tenant safe)
Do **not** put `sk_test`/`whsec` on production Vercel — that would un-dormant billing for the real
TMBS tenant. Use one of:
- **Local**: run the app locally with the test env vars, and `stripe listen --forward-to
  localhost:3000/api/stripe/webhook`. The CLI prints the `whsec_…` to use.
- **A Vercel preview deployment** with the test env vars scoped to that preview only.

Env for the target: `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…` (from `stripe
listen`), `STRIPE_PRICE_ID=price_…` (test).

## Fixtures (throwaway)
1. Create a throwaway **tenant** (register a garage), and a throwaway **rep** with `ref_code = TESTREP`
   (a Rep row — no Reps UI yet, so insert via a script). Set the tenant's `signup_ref = TESTREP` (or
   sign up via `?ref=TESTREP`).
2. Ensure a **GB/GBP `first_12m` £35** rate exists in the Rates screen effective on/before today.
   *(You already added this — 2026-07-01, £35.)*
3. Subscribe the tenant via Checkout so `GroupBilling.stripe_customer_id` is set (the existing
   `checkout.session.completed` handler does this). Confirm `Group.trial_ends_at` mirrors the Stripe
   trial end.

## The acceptance steps
1. **Collected payment (incl. SCA/3DS).** Advance the subscription to its first real charge past
   trial end. Pay with a normal test card `4242 4242 4242 4242`, and separately exercise a **3DS
   challenge** card `4000 0025 0000 3155` (complete the challenge). Either way Stripe emits
   `invoice.paid` once the charge succeeds — 3DS is handled by Stripe *before* the event, so the
   webhook sees the same event.
   - **Expect**: one `CommissionEntry`, `kind='accrual'`, party = the rep, `amount_pennies=3500`,
     `currency='GBP'`, `status='pending'`, `source_ref` = the invoice id (`in_…`).
2. **Refund.** Refund the charge in the Stripe dashboard (full, then try a partial on a later charge).
   - **Expect**: a `kind='clawback'` entry, `amount_pennies=-3500` (full) or pro-rata (partial),
     `payment_ref` = the original invoice id; the two net to zero for that invoice.
3. **Re-delivery (idempotency).** `stripe events resend <evt_id>` for the `invoice.paid` (and the
   `charge.refunded`).
   - **Expect**: **no new entries** — the `StripeEvent` event-id dedupe and the `CommissionEntry`
     `source_ref` unique both block a double-write.
4. **Forged webhook.** `curl -X POST <endpoint>/api/stripe/webhook -d '{}'` with no/garbage
   `Stripe-Signature`.
   - **Expect**: **400 Invalid signature** — nothing written.
5. **Pre-trial.** Trigger an `invoice.paid` while still in trial (e.g. a £0 trial invoice or a payment
   before `trial_ends_at`).
   - **Expect**: **no accrual** (the engine trial-gates on `Group.trial_ends_at`).

## Teardown
Cancel + delete the test subscription/customer in Stripe (test mode); delete the throwaway tenant,
rep, and any `CommissionEntry` rows. Nothing in this runbook touches live data.

## What this does NOT cover (still pending)
- **Live cutover** — real keys, real cards. Separate, deliberate step.
- **The 30-day-arrears *payout timer*** — accruals are written `pending` at collection; the payout run
  that flips `pending → paid` after the arrears window is a separate slice. The clawback carried-debt
  behaviour (pending vs paid netting) IS wired and proven.
