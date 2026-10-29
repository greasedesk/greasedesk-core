# PRODUCTION DEPLOY — 12 commits, 3 migrations, 2026-10-29 evening

Written for the night of the deploy and kept afterwards as the record of what was done.

**Production is running `81129da` ("A garage arrives knowing who sent it").** This tree is at
`cfb8ca7`. Twelve commits, and all of the annual-billing work is in them.

> **Nothing in this file is run by Claude except step 5 (the push), and only when you say so.**
> You run the migrations. Every command below is exact and safe to paste.

---

## 0 — WHAT CHANGES, AND WHERE THE RISK IS

What a garage will see:

- **Pricing and signup carry a Monthly | Yearly toggle, opening on Yearly.** Yearly is the default
  selection on the signup chooser and on the resubscribe door.
- **Every plan now carries the 30-day trial.** This REVERSES the 2026-10-24 rule, under which an
  annual plan took the money up front instead of a trial. An annual garage now gets thirteen
  months of service for its first payment, and that is intended.
- **A referred garage's first-year offer is frozen at signup**, so changing the Engine Room setting
  no longer re-prices garages that signed up before the change.
- **The Licence screen can switch plan during the trial**, and shows a renewal date.
- **A paid annual garage can choose monthly in the last 14 days before renewal**, taking effect at
  renewal. Nothing on production can reach this tonight — the earliest real renewal is 28 November
  — so it will be invisible either way.

Two windows of risk, both short:

1. **Between the migration and the deploy**, production runs `81129da` against the NEW
   `TenantPlanTerms_shape_by_plan` CHECK. That is what `@precedes-deploy` on the first migration
   declares: nothing currently deployed writes a row the replacement constraint forbids. The
   window is safe, but keep it to minutes — push straight after applying.
2. **Between the deploy and the first webhook**, `GroupBilling.current_period_end` stays NULL on
   existing rows. That is expected (see step 7) and is NOT evidence of a failed deploy.

---

## 1 — PRE-FLIGHT (read-only, nothing changes)

```bash
cd /Users/hugh/Developer/greasedesk-core && git status --short && git log --oneline -1
```

Expect **no output** from `git status` and `cfb8ca7` from the log. A dirty tree is a refusal
reason in the migrate wrapper, and rightly so.

```bash
cd /Users/hugh/Developer/greasedesk-core && curl -s https://greasedesk.com/api/version
```

Expect `{"commit":"81129da…","ref":"main","env":"production","source":"runtime"}`. **Write the
commit down** — step 6 compares against it.

### 1b — the one fact no gate can establish

Annual billing derives the Core product from the configured monthly **Price** (`lib/modules`,
`coreProductId`). If the LIVE monthly price belongs to some other product, annual subscriptions
would entitle nothing. No new environment variable is needed — but the fact is worth seeing once,
on the live account, before any garage can buy an annual plan.

In the **Engine Room** (`https://er.greasedesk.com`, operator login + TOTP — owner role, both
calls are owner-only), ask the running deployment which price it resolves to, then ask Stripe what
that price hangs off. Two calls, no guessing at the id:

```
https://er.greasedesk.com/api/superadmin/stripe-lookup?config=1
https://er.greasedesk.com/api/superadmin/stripe-lookup?price=<the RESOLVED id from the first call>
```

The first reports `STRIPE_PRICE_ID`, `STRIPE_PRICE_CORE` and the **resolved** value beside both —
the `??` is the trap, because a stale `CORE` silently wins. Use the resolved one.

From the second: `product.name` must be the **Core** product, `product.active` true, and
`livemode` **true**. If it is not, **stop** — the deploy itself is still safe, but the pricing
toggle goes live with this push and no annual plan should be sold until it is corrected.

Note this call also exercises today's fix: a subscription lookup now returns a real
`current_period_end` (step 8a).

---

## 2 — SNAPSHOT BEFORE

Read-only; SELECTs only, no transaction, no writes.

```bash
cd /Users/hugh/Developer/greasedesk-core && DATABASE_URL="$(grep -E '^DATABASE_URL=' .migrate-target.production | cut -d= -f2- | tr -d '"'"'"'"')" node scripts/entitlement-snapshot.mjs > /tmp/entitlement-before.txt 2>&1; cat /tmp/entitlement-before.txt
```

The first line must read `target: production`. If it says anything else, **stop** — the snapshot is
of some other database and proves nothing about the garages that exist.

Keep `/tmp/entitlement-before.txt`. Step 6 diffs against it.

---

## 3 — APPLY THE THREE MIGRATIONS

**One command.** The wrapper refuses unless the pending set is EXACTLY what `--expect` names, so a
per-migration run would be refused — naming all three IS the guard. They apply in name order:
`20261028120000` → `20261029100000` → `20261029170000`.

```bash
cd /Users/hugh/Developer/greasedesk-core && node scripts/migrate-apply.mjs --yes-production --expect=20261028120000_trial_on_every_plan,20261029100000_group_billing_first_paid_at,20261029170000_affiliate_terms_freeze_offer
```

**Run it plainly in a terminal.** Do not pipe it (`| tee` is refused — the preflight blocks a piped
stdout) and do not redirect it to a file (`>` hides the prompt you have to answer). If you want a
transcript: `script -q /tmp/migrate.txt node scripts/migrate-apply.mjs …` keeps the terminal.

### What you will see

```
  3 migration(s) pending.
    20261028120000_trial_on_every_plan
      declared constraining · SQL reads constraining
      DROP — production may still be reading or writing it
      ADD CONSTRAINT — an existing writer may already breach it
    20261029100000_group_billing_first_paid_at
      declared additive · SQL reads additive
    20261029170000_affiliate_terms_freeze_offer
      declared additive · SQL reads additive

  A pending migration constrains an existing write. Asking production what it is running.
    production: 81129da1dbc2 on main (production, via runtime)
    this tree:  cfb8ca7…

  Production is running this tree's app code. The window is closed; applying.
```

**That last sentence is wrong, and it is wrong harmlessly.** Production is NOT running this tree —
it is running `81129da`. The decision is correct: it comes from the `@precedes-deploy` header on the
first migration, which waives exactly two blockers ("app code is uncommitted" and "app files are not
live") and nothing else. The message is a reporting defect on the board, not a safety one. **Do not
read it as confirmation that the deploy already happened.**

Then the production door:

```
  ── APPLYING TO PRODUCTION ──────────────────────────────────────────
  file      .migrate-target.production
  endpoint  ep-…               → PRODUCTION
  marker    Environment.kind = production
  pending   20261028120000_trial_on_every_plan
            20261029100000_group_billing_first_paid_at
            20261029170000_affiliate_terms_freeze_offer

  Type the endpoint id to apply, anything else to abort:
  >
```

**Type back the endpoint id it just printed** — copy it from that line, not from memory. Anything
else aborts and nothing is applied.

### Expect at the end

```
  APPLIED — and live on the shared database this second.
  Push the migration now. Until it is pushed, this database has a rule no pushed commit explains.
```

It also runs a schema-drift check. **`prisma/schema.prisma and the database now DISAGREE` must NOT
appear.** If it does, stop and tell me before pushing: the schema file and the database have parted
company and the next deploy's drift gate will fail.

### If it refuses

It prints `REFUSED — nothing applied` with the reasons. The likely ones:

| it says | what to do |
|---|---|
| the pending set is not what `--expect` named | somebody added a migration; stop and tell me |
| this is PRODUCTION and `--yes-production` was not given | you left the flag off; re-run |
| stdin is not a terminal | you piped it; run it plainly |
| the database reports no applied migrations at all | **stop and look at the connection** — this is not a migration question |

**Do not reach for `--even-if-not-live`.** Nothing tonight needs it.

### Go straight to step 5 after this

The first window is open from the moment this returns.

---

## 4 — (nothing)

Reserved so the numbering matches what we said on the phone.

---

## 5 — PUSH

```bash
cd /Users/hugh/Developer/greasedesk-core && git push origin main
```

This is the one command Claude will run, on your word. Twelve commits go up. CI runs the gitleaks
scan over the **full** history on push (not the shallow tip) — a red there is a secrets finding,
not a deploy failure, and it does not stop Vercel.

---

## 6 — WATCH THE DEPLOY

Poll production until the new sha appears:

```bash
for i in $(seq 1 40); do printf '%s  ' "$(date +%H:%M:%S)"; curl -s https://greasedesk.com/api/version; echo; sleep 15; done
```

Expect `commit` to flip from `81129da…` to `cfb8ca7…` within a couple of minutes.

### If it does not flip

**"Pushed" has not always meant "deploying" here.** On 2026-10-26 a push to `origin/main` created
no Vercel deployment at all — no build, no deployment row — and the previous deploy had to be done
by hand. It worked on 2026-10-28, so it is intermittent, which is worse than broken: it is the case
where "pushed" quietly stops meaning "deploying" on the night it matters.

So if the sha has not moved after **five minutes**, do not wait longer — go and look:

1. **Vercel → Deployments.** Is there a row for `cfb8ca7` at all?
   - **No row** → no build was attempted. Check **Settings → Git**: the repository connection, and
     the **Ignored Build Step** in particular — an ignore command that exits 0 skips the build
     silently and leaves exactly this trace, nothing at all. Then deploy by hand: open the latest
     commit row and **Redeploy**, or **Deployments → Create Deployment** from `main`.
   - **A row that FAILED** → read the build log. The two most likely causes tonight are a type
     error that `tsc` would have caught (it did not: this tree is clean) and `prisma migrate
     status` exiting non-zero in the build chain because a migration is pending — which cannot
     happen, because you applied all three in step 3.
   - **A row still building** → let it finish. A full build here runs a few minutes.
2. There is **no watcher script** in this repo. The loop above is the watcher.

**The database is already migrated at this point.** A failed build is not an emergency: production
keeps serving `81129da`, which the `@precedes-deploy` header says is safe against the new
constraint. Take the time to read the log.

---

## 7 — SNAPSHOT AFTER

```bash
cd /Users/hugh/Developer/greasedesk-core && DATABASE_URL="$(grep -E '^DATABASE_URL=' .migrate-target.production | cut -d= -f2- | tr -d '"'"'"'"')" node scripts/entitlement-snapshot.mjs > /tmp/entitlement-after.txt 2>&1; diff /tmp/entitlement-before.txt /tmp/entitlement-after.txt; echo "diff exit $?"
```

### What must match

**Every `GroupFeature` line — key, source, enabled, count — and every `GroupBilling`
`subscription_status` line.** The snapshot counts BY SOURCE and BY KEY deliberately: a total alone
would hide the failure that matters, where a `stripe` row flips off while a `grant` row flips on,
nets to zero, and is two garages with the wrong access.

Entitlement moved from the Stripe **price** to the Stripe **product** in `66d0494`. The claim is
that no existing subscriber is affected; the gate proves it over a recorded subscription, and this
diff is the other half — the only evidence about the garages that actually exist.

### What is allowed to differ

Only two lines, and only these:

- the `taken:` timestamp;
- the **group count**, if you register the throwaway garage (step 8) between the two snapshots. Take
  the AFTER snapshot first if you want a clean diff.

**Anything else differing: stop and tell me before anyone is told the deploy is done.**

---

## 8 — SMOKE CHECK (nothing is paid, nothing is charged)

### 8a — the renewal date, which is the fix with the shortest path to proof

In the Engine Room, look up a live subscription:

```
https://er.greasedesk.com/api/superadmin/stripe-lookup?subscription=<sub_… from a live garage>
```

`current_period_end` must now be **a real ISO date, not null**. This reads Stripe live, so it is
true the moment the deploy lands — it does not wait for a webhook.

### 8b — the licence screen's "Renews / next charge" row will still be BLANK, and that is correct

`GroupBilling.current_period_end` is NULL on every production row and there is **no backfill**. The
cache rewrites itself on the next `customer.subscription.updated` for each garage. Until then the
row stays hidden. **Do not read a blank row as a failed deploy** — 8a is the check that the code is
right; this one fills in on its own.

### 8c — the plan chooser (NOT the public pricing page)

**Corrected after the deploy, 2026-10-29.** The first draft of this step said to look for the
toggle on `https://greasedesk.com/pricing` signed out. It is not there and never was.
`PlanChooser` is mounted in exactly two places, both behind auth: `pages/onboarding/billing.tsx`
and `pages/admin/settings/licences.tsx`.

The public `/pricing` page is single-tier and monthly-only — "£75 per site, per month", "Start your
30-day free trial" — and this deploy does not change it. Verified live after the deploy: HTTP 200,
that exact copy, no annual figure anywhere. **That is the correct current state, not a fault**, but
see the note at the foot of this section.

So check the chooser where it actually lives, as part of step 8d: register the throwaway garage,
verify the email, and walk to **`/onboarding/billing`**. Expect:

- a **Monthly | Yearly** toggle, with **Yearly** selected;
- the yearly headline as a **monthly equivalent** (£62.50), with the yearly price (£750) stated
  beneath it, and the saving derived (£150 against 12 × £75);
- a charge sentence naming a **date**, not "in 30 days";
- **stop there.** The next press is Checkout, which takes a card.

> **Worth a decision, not tonight:** annual billing is now live in the product and **invisible to a
> prospect**. A visitor to `/pricing` sees only £75 a month; the yearly price and the saving appear
> only after they have registered and reached the billing step. Everything built this week sells
> annual to someone who has already signed up.

### 8d — a throwaway garage with a referral code (free, but it sends real email)

Register at `https://greasedesk.com/register?ref=<a live affiliate code>` and **stop at the phone
step**. Registration writes a tenant and sends a verification email through Resend; it touches
Stripe **not at all** (the Stripe customer is created at checkout, which you will not reach). So:

- use a **real mailbox you can read** — not `example.invalid`, which works in test mode only;
- expect the referral line to name the affiliate **by name from the attribution**, and the offer to
  be **12 months for the price of 8** with "£600 first year, then £750";
- in the Engine Room → Tenants → the new tenant, confirm `TenantAttribution` exists and
  `TenantAffiliateTerms` carries the **frozen** `offer_months_paid = 8` / `months_given = 12`.

### 8e — what you cannot smoke-test tonight

**The 14-day window.** It needs a paid annual garage inside the fortnight before its renewal, and
the earliest real renewal on this account is 28 November. It is proved by 115 clauses offline and
is rehearsed in `docs/annual-billing-testmode-runbook.md` section E2 on a test clock. Nothing on
production will show it tonight, in either direction.

---

## 9 — CLEAN UP THE THROWAWAY GARAGE

**Do this the same evening.** A live tenant left lying about is a row in every Engine Room count,
and the hourly `prospect-sequence` cron can start emailing it.

Engine Room → **Tenants** → the throwaway → **Purge** (owner role only; Archive is the soft option
and is not enough here).

It asks you to **type the tenant's name exactly**. It targets by id, never by name — the typing is
the confirmation, not the lookup. The purge cancels Stripe (there is nothing to cancel here),
deletes R2 by prefix, deletes the rows in dependency order, sweeps the six subject-keyed tables and
writes a `SuperAdminAudit` row. It is irreversible.

Then re-run the entitlement snapshot if you want the group count back to where it started.

---

## IF IT GOES WRONG

- **The build failed.** Production keeps serving `81129da`. The database is migrated and that is
  safe. Read the log, fix, push again. Nothing to roll back.
- **The deploy landed and something is visibly wrong on the live app.** Vercel → Deployments → the
  `81129da` row → **Promote to Production** (or Rollback). That puts the old code back in front of
  a migrated database, which is the same state as the step-3 window and is safe for the same
  reason. Then tell me what you saw.
- **The entitlement diff is not empty.** Do not roll back on reflex — roll back only if garages are
  losing access. Send me the diff; the snapshot was built to answer exactly this question.
- **The migration half-applied.** The wrapper prints `migrate deploy FAILED. The database may be
  part-applied`. Stop. Do not re-run it and do not push. Send me the output.
