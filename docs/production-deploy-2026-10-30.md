# PRODUCTION DEPLOY — the affiliate programme, 6 migrations

**Written to be read before anything is run. Claude has run none of it.**

Production is on **`965557c`** ("Tie the checkout date to the clock, not to a fixture"), which is
also what `origin/main` points at — so the 2026-10-29 annual-billing deploy is live and settled.

**This file deliberately does not name the commit it deploys.** It named one for an hour, and
committing this file moved it — a plan that hard-codes a hash it invalidates by existing is wrong
from the moment it is written. Step 1 prints the hash and the count; step 6 compares against what
step 1 printed.

> **Claude runs step 5 (the push) and nothing else, and only when you say so.** You run the
> migrations. Every command below is exact and safe to paste.

See **WHICH DATABASE IS PRODUCTION** in `production-deploy-runbook.md` — Neon project `greasedesk`,
account `iain@gunn.tv`, Launch plan, **not** the Scale account. Every command here passes
`.migrate-target.production` explicitly and the wrapper prints `target: production` before it acts.
**If that line says anything else, stop.**

---

## 0 — WHAT CHANGES

**A garage will see:** an optional "How did you hear about us?" on `/register`, and nothing else.
The affiliate site is a new host that nobody is linked to yet.

**You will see:** `affiliates.greasedesk.com` live with a public page and a working signup;
`/superadmin/affiliates` listing affiliates and the waiting list with suspend/unsuspend; "Came via"
on each tenant page; four alert emails; and a login page that stops blaming your password when the
database is unreachable.

**The one behavioural change to an existing path** is that login: a lookup that THROWS now reports
"We can't reach our systems just now" instead of "Invalid email or password". Nothing else about
signing in moves.

### Two windows of risk, both short

1. **Between the migrations and the push**, production runs `965557c` against two new constraints.
   Both are declared in their headers and both are safe in the direction they move — see step 3.
2. **The affiliate signup is live the moment the push lands**, and `affiliate_joining_open` defaults
   to **false**, so the join button is replaced by "Opening soon". That is the intended state: you
   turn it on from the Engine Room when you have seen the page working (step 8).

---

## 1 — PRE-FLIGHT (read-only, nothing changes)

```bash
cd /Users/hugh/Developer/greasedesk-core && git status --short && git log --oneline -1
```

Expect **no output** from `git status`. **Write down the hash the log prints** — that is what
production must be running at step 6. For the count:

```bash
cd /Users/hugh/Developer/greasedesk-core && git log --oneline 965557c..HEAD | wc -l && git log --oneline 965557c..HEAD | cat
```

Expect sixteen or so — the affiliate programme (slices A–D, F, G), the login fix, and this file.
The exact number only matters in that every one of them is work you have approved; if a commit in
that list is unfamiliar, stop.

```bash
cd /Users/hugh/Developer/greasedesk-core && curl -s https://greasedesk.com/api/version
```

Expect `{"commit":"965557c…","ref":"main","env":"production","source":"runtime"}`. **Write it down**
— step 6 compares against it.

### 1b — WHICH MIGRATIONS PRODUCTION IS ACTUALLY MISSING

**Do this rather than trusting the six named below.** This session could not read production (the
permission was refused, correctly), so the list in step 3 is derived from the tree and the deployed
commit, not measured.

A bare `--dry-run` reads `.env`, which is the **gate** database — it would tell you nothing about
production. `--yes-production` is what switches the target, and it needs `--expect`, which takes
**migration names, not a count**. A dry run exits before the production door, so this applies
nothing and asks for no confirmation:

```bash
cd /Users/hugh/Developer/greasedesk-core && node scripts/migrate-apply.mjs --dry-run --yes-production --expect=20261030090000_affiliate_joining_open,20261030110000_affiliate_waitlist,20261030140000_rep_ref_code_case_unique,20261030150000_affiliate_email_verify,20261030170000_group_signup_source,20261030190000_operator_alert_emails > /tmp/pending.txt 2>&1; cat /tmp/pending.txt
```

Expect the production endpoint, then **exactly six pending**, in this order:

```
20261030090000_affiliate_joining_open        additive
20261030110000_affiliate_waitlist            additive
20261030140000_rep_ref_code_case_unique      constraining
20261030150000_affiliate_email_verify        constraining
20261030170000_group_signup_source           additive
20261030190000_operator_alert_emails         additive
```

**If it lists more or fewer than six, stop and tell me.** A seventh would mean something applied
to the gate database never reached this tree, or the 29 October set did not fully land.

### 1c — THE ONE PRECONDITION THAT CAN FAIL A MIGRATION

`20261030140000` creates `UNIQUE INDEX ON Rep (lower(ref_code))`. If production holds two referral
codes differing only by case, **the index cannot be created and the migration fails outright**
(nothing half-applies — the statement simply errors).

```bash
cd /Users/hugh/Developer/greasedesk-core && node scripts/check-ref-code-case.mjs > /tmp/refcase.txt 2>&1; cat /tmp/refcase.txt
```

It was clean on 30 October. **If it now names a collision, stop** — the two codes have to be
reconciled by hand first, and that is a decision about who gets paid, not a migration.

---

## 2 — SNAPSHOT BEFORE

```bash
cd /Users/hugh/Developer/greasedesk-core && DATABASE_URL="$(grep -E '^DATABASE_URL=' .migrate-target.production | cut -d= -f2- | tr -d '"'"'"'"')" node scripts/entitlement-snapshot.mjs > /tmp/entitlement-before.txt 2>&1; cat /tmp/entitlement-before.txt
```

First line must read `target: production`. Keep the file; step 6 diffs against it.

---

## 3 — APPLY THE SIX MIGRATIONS

**All six go BEFORE the push.** Four are additive and apply at any time. The two constraining ones
are also before the push, and here is why each is safe in the window:

| | Migration | Why it is safe to apply while `965557c` is still serving |
|---|---|---|
| 1 | `affiliate_joining_open` | additive — one boolean column, defaulting false |
| 2 | `affiliate_waitlist` | additive — a new table; its UNIQUE and CHECK are inside the CREATE TABLE, so they constrain nothing that exists |
| 3 | `rep_ref_code_case_unique` | **constraining.** The only write it can reject is an INSERT or UPDATE of `Rep.ref_code` that would make two codes differ only by case. The sole deployed writer is an operator creating a rep by hand in the Engine Room, and step 1c proves there is nothing to collide with. |
| 4 | `affiliate_email_verify` | **constraining,** and in the widening direction: it replaces `RepMagicLink_purpose_chk` with one that accepts `'email_verify'` as well as `'sign_in'`. Nothing deployed writes the new value, and the replacement refuses nothing the old one allowed. The genuine window is the instant between the DROP and the ADD, when that column has no CHECK at all. |
| 5 | `group_signup_source` | additive — five nullable columns, no backfill |
| 6 | `operator_alert_emails` | additive — one `TEXT[]` with a default on a one-row table |

### Both constraining migrations now DECLARE that they precede their code

They did not when this file was first written, and the wrapper would have refused the set with
*"push the code, wait for /api/version to report this commit, then apply"*. **That advice is wrong
for this deploy**, and the reason is worth keeping: `getProgrammeSettings` selects every scalar on
`ProgrammeSettings`, so the moment the new code is live it asks for `alert_emails` — and `/`,
`/pricing` and `/llms.txt` all read that row. **Push-first takes the public site down** until the
migration catches up. Migrations first is the only safe order for this set.

So on 2026-10-30, with the owner's approval, each of the two constraining files gained a
`-- @precedes-deploy:` line stating what nothing deployed is constrained by and what in this push
depends on it. That is the mechanism for exactly this inversion, and it means **no
`--even-if-not-live` and no file is edited during the deploy**:

```bash
cd /Users/hugh/Developer/greasedesk-core && node scripts/migrate-apply.mjs --yes-production --expect=20261030090000_affiliate_joining_open,20261030110000_affiliate_waitlist,20261030140000_rep_ref_code_case_unique,20261030150000_affiliate_email_verify,20261030170000_group_signup_source,20261030190000_operator_alert_emails > /tmp/migrate.txt 2>&1; echo "exit $?"; cat /tmp/migrate.txt
```

- **`--expect` names all six.** If the pending set differs by one in either direction the wrapper
  refuses rather than applying what it finds.
- **It will print the endpoint and ask you to TYPE IT BACK.** Not a y/n. Anything else aborts and
  applies nothing. `--yes-production` also refuses when stdin is not a terminal, which is why
  Claude cannot run this step even if asked to.
- **It writes nothing into any migration file**, which is the point of the declaration.

> **The one verdict this file cannot predict.** `deployDecision` has a third blocker beyond the two
> that `@precedes-deploy` lifts: it refuses if `prisma/schema.prisma` adds a **client-generated**
> default that production does not have. The decision is computed before the dry-run exit, so
> **step 1b prints it**. If the dry run still refuses, stop and say so — the answer would be a
> different one, not `--even-if-not-live`.

### What that declaration cost, and why it is already paid

Prisma stores a **sha256 of migration.sql** at apply time, and both files had already been applied
to the **gate** database — so adding a line to them left the gate's ledger holding the old hash,
and the next `migrate deploy` there would have refused. `prisma migrate status` does **not** notice
(measured), so it would have surfaced in the middle of the next slice rather than now.

Two rows on the gate database were updated to the new hashes at the same time as the edit, and read
back to confirm they match the files. **Production is unaffected**: it has never applied either
file, so it will store the new checksum when it applies them.

This is the `--even-if-not-live` mechanism meeting the gate-database split of 26 October — it was
written when a migration file was applied to one database, and each is now applied to two, at
different times. **For the next constraining migration: declare `@precedes-deploy` when the file is
written**, not at deploy time, and the problem does not arise.

---

## 4 — THE CRON, WHICH IS NOT A MIGRATION AND IS THE EASIEST THING TO MISS

`vercel.json` gains a **sixth** cron:

```
40 * * * *   /api/cron/operator-alerts
```

- **It needs `CRON_SECRET`,** which the five existing crons already use — so if they are running,
  this one will authenticate. No new environment variable.
- **Check the project's plan allows six.** Five hourly crons already run, so this is a Pro project
  and six is fine; a Hobby project would both cap the count and refuse hourly schedules. Worth one
  glance at the deploy log rather than a surprise.
- **An alert that never sweeps is the half of slice G that fails silently.** Three of the four
  alerts fire inline and will work whether or not the cron runs. "Registered an hour ago and never
  reached checkout" exists ONLY in the cron, and the catch-up for a send that was cut off is there
  too. Step 7 checks it ran.

---

## 5 — THE PUSH

The only step Claude runs, and only when you say so.

```bash
cd /Users/hugh/Developer/greasedesk-core && git push origin main
```

Fourteen commits. Vercel builds from `main`.

---

## 6 — AFTER THE BUILD

```bash
cd /Users/hugh/Developer/greasedesk-core && curl -s https://greasedesk.com/api/version
```

Expect **the hash you wrote down at step 1**. Until it reports that, the old code is still serving
and everything below will mislead.

```bash
cd /Users/hugh/Developer/greasedesk-core && DATABASE_URL="$(grep -E '^DATABASE_URL=' .migrate-target.production | cut -d= -f2- | tr -d '"'"'"'"')" node scripts/entitlement-snapshot.mjs > /tmp/entitlement-after.txt 2>&1; diff /tmp/entitlement-before.txt /tmp/entitlement-after.txt && echo "IDENTICAL"
```

**Expect IDENTICAL.** Nothing in these commits changes what any existing garage is
entitled to, so a difference here is the first thing worth explaining.

---

## 7 — WHAT YOU VERIFY, IN THE ORDER THAT FINDS PROBLEMS FASTEST

**The public site still works.** The whole programme sits behind pages that `getProgrammeSettings`
reads, and that is reached by `/`, `/pricing` and `/llms.txt`:

```bash
for u in / /pricing /llms.txt /terms /register; do printf "%-12s " "$u"; curl -s -o /dev/null -w "%{http_code}\n" "https://greasedesk.com$u"; done
```

All **200**. A 500 on any of them means a column the deployed code expects is missing — stop and
tell me.

**The new host.** `https://affiliates.greasedesk.com` should serve the affiliate page — hero, the
terms card with the figures from the settings, the four steps, the FAQ, and **"Opening soon: leave
your email"** in place of a join button, because joining defaults to off.

- Leave an address in that box and check it lands in the Engine Room waiting list.
- `https://affiliates.greasedesk.com/terms` should render, and `/robots.txt` should serve.

**The Engine Room** (`https://er.greasedesk.com`, owner login + TOTP):

- **Affiliates** — the screen loads, the waiting list shows your test address, the affiliates table
  is empty (nobody has joined).
- **A tenant page** — "Came via" shows three lines. For every existing garage expect
  *Direct — no referral code was presented at signup*, *not recorded*, *not recorded*. **That is the
  correct answer, not a bug**: nothing captured those two axes before today.
- **Billing** — the "Alerts to you" panel, the box empty, and the line beneath it reading
  *"Nobody has chosen, so alerts go to hugh@greasedesk.com"*.

**A real signup, end to end.** The one test worth doing by hand, because it exercises four of the
several of these commits at once:

1. Register a garage at `https://greasedesk.com/register` with a disposable address, answering
   "How did you hear about us?".
2. **You should receive the "New garage" alert within seconds**, carrying the Came via block with
   your answer in it.
3. Leave it alone for an hour and you should receive **"Registered, no checkout after an hour"**.
   That second email is the cron's proof of life — if it never comes, the cron is not running, and
   step 4 is where to look.
4. Delete nothing. Tell me the tenant ref and I will clear it properly.

**The login fix**, which is the one change to an existing path:

- A wrong password on `/admin/login` must still say *"Invalid email or password."* — the fix must
  not have made every failure read as an outage.

---

## 8 — AND THEN, DELIBERATELY, TURN IT ON

Nothing is open until you do this, and that is by design.

- **Engine Room → Affiliates → "New affiliates can join"**. The affiliate site is server-rendered
  with no ISR, so the switch takes effect on the next page load — no cache to wait for.
- Join once yourself, with a real handset, and check: the SMS arrives, the code is accepted, the
  welcome email carries the code, the link and the QR, **and you receive the "New affiliate" alert**.
- Then suspend yourself and check the row says what suspension did, and unsuspend.

---

## IF SOMETHING GOES WRONG

- **The build fails.** Production keeps serving `965557c`. The database is already migrated, which
  is safe — all six are either additive or widening, and `965557c` wrote none of the new columns.
  Fix and push again; nothing needs unwinding.
- **`20261030140000` fails on a duplicate.** Nothing applied. Reconcile the two codes first
  (step 1c) — and that is a decision about who gets paid.
- **A public page 500s after the push.** Almost certainly a migration that did not apply while the
  code expecting it did deploy. Re-run step 1b: it will name what is still pending.
- **Alerts do not arrive.** Check `/superadmin/billing` first — the last twenty attempts are listed
  there with their status and the reason for any failure. A `skipped` row with "not configured"
  means the email provider, not this code.
- **The alert emails arrive twice.** That would mean the idempotency is not holding, which the gate
  says it does. Tell me the two timestamps and the garage; do not turn the cron off — the same
  rows are what would diagnose it.

---

## WHAT IS DELIBERATELY NOT IN THIS DEPLOY

- **The affiliate portal (slice E)** — held, by your decision.
- **`BackupRun` is still empty** and the backup report still fails on its pipe. Boarded.
- **No cron run logging**, so a cron that fails leaves no record in the product. Boarded, and it is
  why step 7's one-hour email is the test of whether the new cron runs at all.
