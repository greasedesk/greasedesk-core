# Annual billing — test-mode acceptance runbook

Three checkouts, a plan switch and a clock advance. Everything here is **test mode**: test keys,
test cards, test clocks, throwaway tenants. No live key is used and no real card is charged.

Written 2026-10-28, for the slice that added annual billing, the trial on every plan, entitlement
by product and the trial-end reminder.

---

## 0. WHERE THIS RUNS, AND WHY NOT ON PRODUCTION

**Run it locally: the dev server on port 3010, against the `greasedesk-gate` database, with test
Stripe keys and the Stripe CLI forwarding webhooks.**

That is the only arrangement where all four things are under our control at once — the database,
the webhook endpoint, the Stripe account and the clock — and where nothing that happens is visible
to anybody else.

**Not production, for a reason that holds whatever keys it has.** Production is the live database:
7 real groups, 4 with subscriptions, real billing addresses and a real notification path. A test
checkout there creates a real tenant row, a real `GroupBilling` row and a real `NotificationLog`
send. Even a perfect test leaves litter in the records the business runs on.

**PRODUCTION IS ON LIVE KEYS.** **PRODUCTION IS ON LIVE STRIPE KEYS — confirmed in the live dashboard by the owner, 2026-10-28.** Live Stripe holds three subscriptions, all `trialing` with trials ending late 2027 by deliberate choice: The Mini & BMW Specialist, G-Force Auto Services, Hugh's Garage. Nothing is `active` in live.

The repo said otherwise in two places and both were wrong — the 2026-07-28 survey recorded "keys
configured but TEST-mode", and `docs/billing-commission-testmode-runbook.md` said billing was
"dormant in prod". Both are corrected as of this check. The lesson is worth more than the fact: a
claim about the live environment was three months old, had never been re-tested, and two documents
had quietly inherited it.

So the instruction is not "be careful with production", it is **nothing in this runbook goes near
production**. A mistake there is a real card and a real charge, not a sandbox row.

**Do not put `sk_test_…` or a `whsec_…` on production Vercel.** On live keys that would point
three real subscriptions at a test billing path. And annual checkout CREATES Stripe objects — an
inline price and a coupon — rather than only reading one, so a misdirected run leaves objects
behind in whichever account it reaches.

### What you must set up first (none of it exists on this machine today)

1. **Confirm the Core product.** In the Stripe **test** dashboard, open the Price in
   `STRIPE_PRICE_ID` and note its **product**. Everything in this slice assumes monthly and annual
   are two prices of that one product — it is what makes their access identical. I could not check
   this from here: there is no Stripe key in the local `.env` at all.
2. **Local Stripe env.** Add to `/Users/hugh/Developer/greasedesk-core/.env`:
   `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PRICE_ID=price_…` (test), and later the `whsec_…` the CLI
   prints. There are currently **no** `STRIPE_*` variables there.
3. **Stripe CLI.** Not installed (`stripe` is not on PATH). `brew install stripe/stripe-cli/stripe`
   then `stripe login`.
4. **Point the webhook at the dev server:**
   `stripe listen --forward-to localhost:3010/api/stripe/webhook`
   Put the `whsec_…` it prints into `.env` as `STRIPE_WEBHOOK_SECRET` and restart the dev server.
5. **Check the database.** The dev server reads `DATABASE_URL`, which is the gate project
   (`ep-dry-forest-zae738ze`). Confirm with
   `node -e "import('./scripts/_db-target.mjs').then(m=>console.log(m.describeTarget()))"` — it must
   print `safe: true`.
6. **Apply the migration** if you have not: `node scripts/migrate-apply.mjs`. Annual terms cannot be
   written until `TenantPlanTerms_trial_xor_paynow` is gone.

### Throwaway fixtures

- A garage per checkout, registered through `/register` with a `@example.invalid` address.
- One affiliate for checkout C: a `Rep` row with `party_type: 'affiliate'` and a known `ref_code`.
- Delete them afterwards. They are on the gate database, so nothing is at stake, but a stale
  fixture is the thing the next run mistakes for a result.

---

## A — MONTHLY (the regression)

The path that already worked. Run it first: if A is wrong, B and C tell you nothing.

1. Register a garage at `http://localhost:3010/register`.
2. Reach checkout and choose **monthly**. Confirm the screen says **£75**.
3. Pay with `4242 4242 4242 4242`, any future expiry, any CVC.

**Confirm — in Stripe:** subscription `trialing`; trial ends in 30 days; one item, £75/month; no
discount.

**Confirm — in the database:**
```sql
SELECT plan, trial_days, paid_now_pennies, months_paid FROM "TenantPlanTerms" WHERE group_id = '<id>' ORDER BY effective_from;
SELECT feature_key, source, enabled FROM "GroupFeature" WHERE group_id = '<id>';
```
Expect `monthly / 30 / NULL / NULL`, and `web`+`inbound` rows written `false` with source `stripe`.
**There will be no `core` row** — core is never written from Stripe, and that is correct.

---

## B — ANNUAL, UNREFERRED

1. Register a second garage. Choose **annual**. Confirm the screen says **£750**.
2. Pay with `4242 4242 4242 4242`.

**Confirm — in Stripe:** subscription `trialing`, **nothing charged yet**; one item at
**£750/year**; **no discount**; the item's price belongs to **the same product as the monthly
price** (this is the check that answers question 9 — compare it against step 0.1).

**Confirm — in the database:** `TenantPlanTerms` has a second row,
`annual_renewal / 30 / 75000 / 10`. The first row still says `monthly` — that is what they signed
up under and a later choice must never erase it.

**Confirm — entitlement:** the `GroupFeature` rows are **identical to A's**. Two prices, one
product, one level of access.

---

## C — ANNUAL WITH AN AFFILIATE CODE

1. Create the affiliate (`party_type: 'affiliate'`, `ref_code: 'TESTAFF'`, a `@example.invalid`
   email that is **not** the garage's).
2. Register a third garage via `http://localhost:3010/register?ref=TESTAFF`. The referral field
   should prefill itself from the URL — no cookie, no consent banner interaction needed.
3. Confirm the attribution landed before going further:
   `SELECT party_type, party_id, share_bp FROM "TenantAttribution" WHERE group_id = '<id>';`
4. Choose **annual**. Confirm the screen says **£600**.
5. Pay with `4242 4242 4242 4242`.

**Confirm — in Stripe, and this is the clause that matters most:**
- the subscription item is **£750/year**, NOT £600;
- a coupon `gd-first-year-15000-gbp` is attached, **duration `once`**, £150 off;
- nothing charged yet (trialing).

**Then read the upcoming invoice** (Stripe dashboard → the subscription → *Upcoming invoice*). It
should show **£600** — £750 less the once-only £150.

**Confirm — in the database:** `TenantPlanTerms` latest row is `annual_offer / 30 / 60000 / 8`, and
`TenantAffiliateTerms` names the affiliate with the frozen reward.

---

## D — SWITCH PLAN DURING THE TRIAL

On garage **C**, still trialing:

1. `POST /api/stripe/change-plan` with `{"plan":"monthly"}` (from the licences screen, or curl with
   a real admin session).
2. **Confirm:** the subscription item is now £75/month; **the trial end date has not moved**;
   nothing has been charged; no proration line appears anywhere.
3. Switch back with `{"plan":"annual"}`. Confirm it returns to £750/year **with the coupon still
   attached** — the garage did not lose its offer by changing its mind.
4. **Confirm the timeline appends rather than overwrites:**
   `SELECT plan, effective_from FROM "TenantPlanTerms" WHERE group_id = '<id>' ORDER BY effective_from;`
   Expect four rows: `monthly` (signup), `annual_offer`, `monthly`, `annual_offer`. The earliest
   row is still the signup one.
5. **Confirm the door closes.** After step E below, call `change-plan` once more: it must refuse
   with `TRIAL_OVER` and change nothing.

---

## E — ADVANCE THE CLOCK PAST THE TRIAL END

**This needs a Stripe Test Clock, and a test clock has to be attached to the CUSTOMER when the
customer is created.** Our code creates the customer itself inside `checkout.ts`, so a clock cannot
be attached after the fact. Do this instead, before the checkout you want to advance:

1. In the Stripe test dashboard, create a **test clock** set to today.
2. Create a **customer on that clock**.
3. Seed it onto a fresh throwaway garage *before* its checkout:
   `UPDATE "GroupBilling" SET stripe_customer_id = '<cus_…>' WHERE group_id = '<id>';`
   The checkout path reuses an existing `stripe_customer_id` rather than creating one, so the
   session lands on the clocked customer.
4. Run checkout **C** against that garage.

Then advance:

5. **Advance the clock to 27 days** (three days before trial end). Expect
   `customer.subscription.trial_will_end` in the `stripe listen` output, and in the dev server log
   `[stripe] trial_will_end → sent: annual £600.00`. **Check the email**: it must name the plan,
   **£600.00**, the date, and say it renews at £750.00 after that.
6. **Advance the clock past 30 days.** Expect:
   - an invoice for **£600.00** (£750 less the once-only coupon), paid;
   - the subscription goes `trialing` → `active`;
   - `invoice.paid` fires, and `GroupBilling.subscription_status` becomes `active`.
7. **THE CLAUSE NO GATE CAN PROVE.** Read the **next** upcoming invoice. It must be **£750.00**.
   If it says £600, the coupon is not `once` and every referred garage is discounted for life.
8. **Advance a year** and confirm the renewal invoice is **£750.00** and actually collected.

---

## What to tear down

Delete the throwaway groups and the affiliate from the gate database, and remove the test clock in
Stripe (deleting a clock deletes its customers and subscriptions). Leave `.env` as you found it if
you would rather not keep Stripe keys on the machine.
