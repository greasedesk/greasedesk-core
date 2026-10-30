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

### THE PHONE STEP CANNOT BE COMPLETED ON THE GATE DATABASE

**It is not a bug, and resending will never help.** Two correct rules collide:

- `lib/environment.ts` refuses **every** send while the `Environment` marker reads `test` —
  *"nothing is sent from the gate database"*. It sits immediately before the provider call, fails
  closed, and is not bypassed by `security: true` templates, so the emailed fallback is refused too.
- `sendPhoneVerification` calls `clearCodes()` on any failed send, because *"leaving it would let
  the user sit on an 'enter the code' screen for a code that never left the building"*.

So the code is minted, the send is refused, and the code is deleted. `DeliveredCode` ends up empty
and there is **nothing to read back** — the hash is not the obstacle, the absent row is. Pressing
"Send me a code" again repeats all three steps. `storeUnverified` does save the number, but the
root gate wants `TwoFactorSecret.phone_recorded_at`, which is written only on **confirmation**, so
"continue and confirm later" does not satisfy it either.

**Do not flip the `Environment` marker.** It is the same switch `gatePrisma()` requires, so every
gate would decline to run — and a gate database that can send is a gate database that emails real
people.

**Use the documented break-glass.** `lib/onboarding.ts` names exemption as one of three ways the
step can be complete, and production grants it through
`pages/api/superadmin/tenant-phone-exempt.ts`. That endpoint is unreachable here only because the
gate database has no `Operator` row, so write the same three columns directly, **once per garage**:

```sql
UPDATE "Group" SET
  phone_step_exempt_at = now(),
  phone_step_exempt_reason = 'Local rehearsal: no code can be delivered from the gate database (lib/environment refuses every send while the Environment marker reads test), and sendPhoneVerification clears the code on a failed send, so the step cannot be completed here.',
  phone_step_exempt_by = NULL
WHERE id = '<group id>';
```

Scope it by `id`, check it reported **exactly one** row, and leave `phone_step_exempt_by` **NULL** —
it holds an operator's user id and no operator granted this. The honest record is "this garage
skipped the step, and here is why".

**Never write `TwoFactorSecret.phone_recorded_at` instead.** It is one column rather than three and
it is a lie: that column exists to mean *a handset answered*, and nothing downstream could later
tell the difference.

---

## THE FIGURES, AND WHERE THEY COME FROM

**Nothing below is a literal.** Every amount in this runbook is derived from
`ProgrammeSettings` plus the country's monthly price, and the settings on the database you are
rehearsing against are **not** the settings in production — an Engine Room edit is made against
production and nothing carries it across (see the standing board). Read the settings first, then
compute what to expect. A runbook that named the numbers would have you confirming the arithmetic
of a different database.

| symbol | source | gate DB, 2026-10-28 |
|---|---|---|
| `M` monthly price | **code**, not a setting: the country profile's `monthlyPrice` (GB) | £75 |
| `T` trial days | `ProgrammeSettings.trial_days` | 30 |
| `R` renewal months charged | `ProgrammeSettings.renewal_annual_months_paid` | 10 |
| `O` offer months charged | `ProgrammeSettings.offer_months_paid` | **6** |
| `G` months of service given | `ProgrammeSettings.months_given` | 12 |

Derived:

| quantity | formula | gate DB today |
|---|---|---|
| annual price | `R × M` | **£750** |
| affiliate first-year price | `O × M` | **£450** |
| first-year discount | `(R − O) × M` | **£300** |
| coupon id | `gd-first-year-<discount pennies>-gbp` | **`gd-first-year-30000-gbp`** |

And the three figures the **screen** shows, which are comparisons and not charges — the monthly
equivalent exists only so yearly can be read against monthly, and nothing bills monthly on the
yearly plan:

| quantity | formula | unreferred | referred |
|---|---|---|---|
| headline, per location | `year price ÷ G` | **£62.50** /month | **£37.50** /month |
| money saving, per location | `G × M − year price` | **£150** a year | **£450** a year |
| percentage on the toggle | `(G − months charged) ÷ G` | **Save 17%** | **Save 50%** |

Read them for yourself before you start:

```sql
SELECT trial_days, renewal_annual_months_paid, offer_months_paid,
       affiliate_signups_open,  -- the GARAGE OFFER (the name is wrong; see the affiliate plan)
       affiliate_joining_open   -- may a PERSON join the programme (added 2026-10-30, closed by default)
FROM "ProgrammeSettings" WHERE id = 'singleton';
```

**Production holds `O` = 8**, so the offer a real garage sees is `8 × £75` = £600 with a £150
discount. The gate database holds 6 because it predates the Engine Room edit of 2026-10-26.
Rehearsing at 6 is deliberate (owner, 2026-10-28): at 8 the expected figures coincide with the
schema defaults, so a hardcoded constant anywhere in the chain would pass unnoticed.

## A — MONTHLY (the regression)

The path that already worked. Run it first: if A is wrong, B and C tell you nothing.

1. Register a garage at `http://localhost:3010/register`, GB, with a `@example.invalid` address.
   The verification email **will not arrive** (same send refusal as above), so take the link from
   `VerificationToken` instead. Then walk all six wizard steps —
   `country → phone → site → rates → tax → checkout` — granting the phone exemption above when you
   reach step 2.
2. Reach checkout. The step opens on **Yearly** (owner, 2026-10-29) — click **Monthly** on the
   toggle, and confirm the panel follows it: headline **`M`** (£75) */month*, "Billed monthly.
   Cancel any time.", and a charge sentence naming the end date and **`M`**. If the charge
   sentence still names the yearly figure, stop: the panel and the toggle have come apart.
3. Pay with `4242 4242 4242 4242`, any future expiry, any CVC.

**Confirm — in Stripe:** subscription `trialing`; trial ends in 30 days; one item, £75/month; no
discount.

**Confirm — in the database:**
```sql
SELECT plan, trial_days, paid_now_pennies, months_paid FROM "TenantPlanTerms" WHERE group_id = '<id>' ORDER BY effective_from;
SELECT feature_key, source, enabled FROM "GroupFeature" WHERE group_id = '<id>';
```
Expect `monthly / T / NULL / NULL` (so `monthly / 30 / NULL / NULL` today), and `web`+`inbound`
rows written `false` with source `stripe`.
**There will be no `core` row** — core is never written from Stripe, and that is correct.

---

## B — ANNUAL, UNREFERRED

1. Register a second garage. At the checkout step **Yearly is already selected** — touch nothing.
   Confirm four things:
   - the toggle's Yearly tab carries **`(G − R) ÷ G`** as a percentage (**Save 17%** today);
   - the headline is the monthly equivalent **`R × M ÷ G`** (**£62.50** */month*), *per location*;
   - beneath it, "Billed **`R × M`** a year" (£750) and "Save **`G × M − R × M`** a year" (£150);
   - the charge sentence reads "…then £750 for 12 months" — the **total**, not £62.50.

   An unreferred garage must show **no** first-year / renewal split — there is no offer to
   explain.
2. Pay with `4242 4242 4242 4242`.

**Confirm — in Stripe:** subscription `trialing`, **nothing charged yet**; one item at
**`R × M` per year**; **no discount**; the item's price belongs to **the same product as the monthly
price** (this is the check that answers question 9 — compare it against step 0.1).

**Confirm — in the database:** `TenantPlanTerms` has a second row,
`annual_renewal / T / (R × M in pennies) / R` — `annual_renewal / 30 / 75000 / 10` today. The first
row still says `monthly` — that is what they signed up under and a later choice must never erase
it.

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
4. **Yearly is already selected.** Confirm **four** things, because this is the mis-sale case:
   - the headline is the **first-year** monthly equivalent **`O × M ÷ G`** (**£37.50** */month*);
   - the line beneath states **both**: "£450 for your first year, then £750 a year" — and the
     plain "Billed £X a year" line is **gone**, replaced, not shown as well;
   - the saving is against monthly at the **offer** price: "Save £450 a year", and the toggle
     reads **`(G − O) ÷ G`** (**Save 50%**);
   - the charge sentence also names both figures.

   If the first-year price appears alone, stop — the garage would learn the real figure from its
   second invoice.
5. Pay with `4242 4242 4242 4242`.

**Confirm — in Stripe, and this is the clause that matters most:**
- the subscription item is **`R × M` per year** (£750), **NOT** the discounted figure — the
  discount must live on a coupon, never in the price;
- a coupon `gd-first-year-<(R − O) × M in pennies>-gbp` is attached — **`gd-first-year-30000-gbp`**
  today — **duration `once`**, `(R − O) × M` off (£300);
- nothing charged yet (trialing).

**Then read the upcoming invoice** (Stripe dashboard → the subscription → *Upcoming invoice*). It
should show **`O × M`** (£450) — `R × M` less the once-only `(R − O) × M`.

**Confirm — in the database:** `TenantPlanTerms` latest row is
`annual_offer / T / (O × M in pennies) / O` — `annual_offer / 30 / 45000 / 6` today — and
`TenantAffiliateTerms` names the affiliate with the frozen reward.

---

## D — SWITCH PLAN DURING THE TRIAL

On garage **C**, still trialing, on **Settings → Licence**. Rehearsed 2026-10-29 and **FAILED at
step 2** — see the box at the end of this section; the figures below are what the fixed build owes.

1. The toggle opens on **Yearly**. Click **Monthly**, check the panel reads **£75 /month**, then
   press **Switch to monthly**. (Equivalently: `POST /api/stripe/change-plan` with
   `{"plan":"monthly"}`.)
2. **Confirm on the Stripe subscription:** the item is **£75/month**, `gd_plan` is `monthly`, the
   **trial end has not moved**, no proration line anywhere — and **the discount is GONE**. No
   `gd-first-year-…` coupon, nothing under Discounts, and the upcoming invoice reads **£75**, not
   £0.00. This is the clause that failed.
3. **Confirm on the screen, without reloading again:** the page comes back saying *"You're on the
   **monthly** plan"*. It reads the tail of `TenantPlanTerms`, which `change-plan` now writes
   itself rather than waiting for the webhook.
4. Toggle back to **Yearly**. Before pressing, check it still reads **£37.50 /month**, **"£450 for
   your first year, then £750 a year"**, **Save 50%**, and the referral reason naming the affiliate
   at **"price of 6"** (C's frozen months, not the live setting). Press **Switch to yearly**.
5. **Confirm:** item back to **£750/year**, `gd-first-year-30000-gbp` **attached again** at
   `duration: once`, **upcoming invoice £450**, trial end still unmoved. The garage did not lose
   its offer by changing its mind, and did not spend it either — `first_paid_at` is still NULL.
6. **Confirm the timeline appends rather than overwrites:**
   `SELECT plan, paid_now_pennies, months_paid, effective_from FROM "TenantPlanTerms" WHERE group_id = '<id>' ORDER BY effective_from;`
   The new `annual_offer` row must read **45000 / 6** — the frozen months. A row reading 60000 / 8
   is the live setting leaking in, which is the defect `planForGarage` fixed.
7. **Confirm the door closes.** After step E below, call `change-plan` once more: it must refuse
   with `ANNUAL_PAID` (a paid year, changeable at renewal) rather than `TRIAL_OVER`, and the
   licences screen must show the `plan-switch-locked` note instead of the control.

> **WHAT D1 FOUND, 2026-10-29.** After the switch to monthly the £300 coupon was still attached and
> the upcoming invoice read £0.00. `lib/plan-switch` sent `discounts: []`, and that fails twice
> over: Stripe treats an empty **array** as *leave the discounts unchanged* (only the empty
> **string** clears), and stripe-node form-encodes an empty array to nothing at all, so the field
> never left the process. The gate asserted the object we built, which was never the thing that was
> wrong; it now asserts the encoded request body through stripe-node's own transport.
>
> D1 also found the licences screen still saying *"You're on the yearly plan"*: it reads the terms
> timeline, only the webhook wrote it, and the browser reloads the instant `change-plan` returns —
> a second or so before the event lands.

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
   `[stripe] trial_will_end → sent: annual £450.00` (`O × M`). **Check the email**: it must name
   the plan, **`O × M`**, the date, and say it renews at **`R × M`** after that.
6. **Advance the clock past 30 days.** Expect:
   - an invoice for **`O × M`** (£450) — `R × M` less the once-only coupon — paid;
   - the subscription goes `trialing` → `active`;
   - `invoice.paid` fires, and `GroupBilling.subscription_status` becomes `active`.
7. **THE CLAUSE NO GATE CAN PROVE.** Read the **next** upcoming invoice. It must be **`R × M`**
   (£750.00) — the UNDISCOUNTED figure. If it still shows `O × M`, the coupon is not `once` and
   every referred garage is discounted for life. This is the one assertion whose expected value
   does not move with `O`, which is exactly why it is the one that matters.
8. **Advance a year** and confirm the renewal invoice is **`R × M`** (£750.00) and actually
   collected.

### E2 — the fourteen-day window (needs the same clock, between steps 7 and 8)

The window is the only part of the annual design no gate can reach: it needs a real subscription
with a real renewal date, and the clauses in `annual-billing-gate` prove the arithmetic and the
schedule parameters while `plan-choice-gate` drives the screen through the CACHED date. The live
limb — Stripe's own `items.data[0].current_period_end`, and `sub.schedule` — is proved here.

After step 7 the garage is annual, `active`, paid, with a renewal about a year out.

9. **Open Settings → Licence & Subscriptions.** Expect the switch to be ABSENT and a note reading
   *"You can change to monthly from ‹renewal − 14 days›, the last 14 days before your renewal on
   ‹renewal›."* Both dates must be real, and **"Renews / next charge" must now show a date** —
   that row was empty for every garage until 2026-10-29.
10. **Advance the clock to 20 days before renewal.** The note must still be there, unchanged. Call
    `POST /api/stripe/change-plan {"plan":"monthly"}` directly: **409 `ANNUAL_PAID`**, carrying
    `opensAt` and `renewalAt`.
11. **Advance to 10 days before renewal.** The note is gone and **"Move to monthly at renewal"** is
    there. Press it. Then in Stripe:
    - the subscription now carries a **schedule**;
    - **phase 1 is unchanged**: same price, same quantity, **same end date** — this is the whole
      promise, and `holdFidelity` refuses the hold if it is not;
    - **phase 2** is the monthly price × sites from the renewal date, `iterations 1`, metadata
      `gd_plan=monthly`, **no discount**;
    - `end_behavior` is **release**;
    - **no `TenantPlanTerms` row was written** — the garage is still on the yearly plan today.
12. **Press "Stay on yearly".** The schedule is released, `sub.schedule` is null, phase 1 is still
    the untouched paid year, and the screen is back to the window block. Then press
    "Move to monthly at renewal" again to re-arm it for the next step.
13. **Advance past the renewal date.** Expect:
    - an invoice for **`monthly × sites`** (£75 × sites), **not** `R × M`;
    - the subscription is monthly, the schedule has **released** itself, and `sub.schedule` is null;
    - `gd_plan` on the subscription is now `monthly`, and the webhook has appended **one**
      `TenantPlanTerms` row with `plan = 'monthly'` — dated the renewal, not fourteen days earlier;
    - the licences screen shows the monthly plan with no window block.

**One thing to try on purpose while the hold is in place (step 11):** add a location. The quantity
sync cannot re-rate a scheduled subscription, so expect the site to be added, the Stripe quantity to
stay as it was, and an **audit row `billing.quantity_sync_blocked`** naming both counts. That is the
known limit of this design, recorded rather than fixed.

---

## What to tear down

Delete the throwaway groups and the affiliate from the gate database, and remove the test clock in
Stripe (deleting a clock deletes its customers and subscriptions). Leave `.env` as you found it if
you would rather not keep Stripe keys on the machine.
