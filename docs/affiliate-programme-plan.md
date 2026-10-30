# AFFILIATE SIGNUP AND PORTAL — PLAN FOR APPROVAL

Nothing built. Measured against the code on 2026-10-29, production at `965557c`.

---

## 0 — WHAT IS ALREADY THERE

More than the brief assumes, which changes the shape of the work.

| Already built | Where |
|---|---|
| `Rep` is **already dual-purpose** — `party_type: rep\|affiliate`, `find_method`, `social_handle`, `terms_accepted_at`, `suspended_at`, `age_verified_at`, `phone`/`phone_e164`, unique `ref_code`, bank fields under an all-or-none CHECK | `prisma/schema.prisma:957` |
| The reward rules, the cap, the offer-vs-monthly split, the freeze at signup | `lib/affiliate.ts` |
| `?ref=` → attribution, typed code beats link, first click wins, 90-day cookie on `.greasedesk.com` | `lib/attribution.ts` |
| Case folding **already applied to affiliate codes** at match time | `findPartyByRefCode` |
| The ledger: `CommissionEntry` with `status` pending/held/released/billed/paid/void, `kind` accrual/clawback, pay runs | `lib/rep-pay-run` |
| A magic-link portal with its own rate-limit key, login, profile | `pages/rep/*`, `lib/rep-magic-link` |
| SMS code verification that **already accepts a `rep` subject** and a `phone_verify` purpose | `lib/phone-verification`, `lib/delivered-code` |
| `affiliate_signups_open` | `ProgrammeSettings` |
| `qrcode` as a dependency | `package.json:41` |
| The code-collision check script, written and **never run** | `scripts/check-ref-code-case.mjs` |

So items 2, 3 and 6 are mostly **wiring and screens on existing models**, not new systems.

---

## 1 — ANSWER TO YOUR QUESTION 5: IS ANY OF IT WIRED?

**The reseller side is. The affiliate side is not.**

`pages/api/stripe/webhook.ts:162` calls `accrueFromInvoicePaid` → `lib/commission-billing` →
`lib/commission`. That is the **rep** engine, with rates and tapers.

`lib/affiliate.ts::rewardPaidInvoice` — which implements your £30 × 4 / £120-cap / single-£120-on-offer
rules exactly — **has no production caller.** The only callers in the repo are five lines in
`scripts/affiliate-gate.mjs`.

**No affiliate has ever accrued anything, and nothing would have told us.** It is correct,
gated, and unreached. Another one for the built-and-unread list.

`charge.refunded` → `clawbackFromChargeRefunded` is wired, again for reps only.

---

## 2 — THINGS I THINK ARE WRONG, OR HIDE MORE WORK THAN THEY LOOK

### 2.1 `affiliate_signups_open` is one control answering two questions

`refuseOffer()` reads it to decide whether **a garage may take the discount**. Item 6 wants it to
mean **whether a new affiliate may join**. Today, closing signups would silently stop referred
garages getting their £600 first year.

You are right to want a second switch. It needs a migration. **And item 4 makes it sharper:** if
every garage signup mints a personal affiliate code, `affiliate_signups_open` cannot gate that
either, so it is really *three* questions — public joining, automatic personal codes, and the
garage discount. I would split it into two columns and leave the personal codes ungated, with a
note saying why.

### 2.2 The payee choice is the biggest hidden scope in the task

"me / my garage, as **account credit** or bank / someone else". Account credit against a garage's
subscription is a Stripe credit-balance or credit-note mechanism **we have not built** and which
interacts with VAT (a credit against a VAT invoice is not the same document as a payment to a
person). `lib/commission-billing`, the pay run and the rep invoice all assume **money out to a
party**.

**Recommendation:** record the *choice* now (it is cheap and it is what the portal promises), and
implement only **bank transfer to the named recipient** for December. Show the credit option as
"from \<date\>" or leave it out of the first release. Deciding this later costs nothing; building
it now is its own slice with VAT questions in it.

### 2.3 Item 4 has three real problems, not one

- **`Rep.email` is `@unique`.** One person who signs up a second garage with the same email cannot
  get a second affiliate row, and the signup would fail at the database. Needs a decision: one
  affiliate per person (my preference — look up by email, reuse the row) or per garage.
- **Self-referral must bite at ACCRUAL, not just at signup.** `refuseSelfReferral` exists and runs
  at signup. But a personal code can be used later by a garage the person has since joined as
  staff, and your term says "no earning on a garage you own or work for". That is a check
  `rewardPaidInvoice` has to make against the *current* relationship, every time it accrues.
- **A one-line terms acceptance would set `terms_accepted_at` for people who have not read the
  terms.** That column is the evidence that somebody agreed to a money contract. I would store it
  as a distinct, weaker fact (accepted the *referral* line at signup) rather than overloading the
  one that means "read and accepted the affiliate terms", and require the full acceptance the
  first time they open the portal.

### 2.4 Case-insensitive codes reverses a parked ruling

On the board: *"PARKED 2026-10-28 — REP CODES STAY CASE-SENSITIVE (owner ruling: park the check)."*
Affiliate codes already fold at match time; what is missing is a **creation-time** guard, because
`ref_code @unique` is case-sensitive in Postgres, so `ABC` and `abc` can both exist and the folded
lookup would then find two and refuse as ambiguous.

`scripts/check-ref-code-case.mjs` was written to answer whether production already holds such a
pair, and **has never been run.** It must run before any constraining migration — a unique index on
`lower(ref_code)` fails on a live collision. That is a read-only script against production: your
call whether I run it or you do.

### 2.5 The 14-day hold should be derived, not stored

`CommissionEntry.status` has `held`, but `held_reason` is an area-manager hold from
`lib/rep-pay-run::HOLD_REASONS`, paired to it by a CHECK. A **time** hold is a different fact and
putting it in the same two columns would make a released line indistinguishable from a matured one.

**Recommendation: no column.** Derive payability from `created_at + 14 days` in one predicate, the
way the renewal window derives from the renewal date. If the hold length must be operator-editable
later, it then belongs in the **frozen** terms (`TenantAffiliateTerms`), not in live settings —
otherwise changing it moves money that was already earned.

### 2.6 "Chargeback" cannot be fully honoured yet

A refund is us giving money back; a chargeback is the bank taking it, and they differ in timing,
cost and who decided — four ways, per the banked design. **`Dispute` is designed and unbuilt.** So
I can wire `charge.refunded` today and record the chargeback intent, but "the reward follows the
money" on a chargeback is only as good as `charge.dispute.*`, which nothing currently handles.

I would write the policy into `lib/affiliate` now (it replaces `REFUND_POLICY_UNDECIDED`, which is
a flag with no reader), wire the refund half, and state the chargeback half as **pending the
dispute slice** rather than claim it.

**Amended by the owner, 2026-10-30 (after slice A shipped):** only a **full** refund of the
invoice reverses the reward. A **partial** refund leaves it standing — it is usually goodwill, our
decision and not the affiliate's, and it should not cost them. Slice A first shipped the opposite
reading (any refund reversed the whole reward), and this is the correction. Consequences, all of
them built: the question is asked of the **cumulative** total refunded on the charge, so three
partials that together take the whole charge back *are* a full refund and the third one reverses
it; the reversal is therefore one decision about the charge rather than one per refund, keyed on
the refund that **completed** it; and `reverseAffiliateReward` now requires both the charge amount
and the refunded total, with no default, because the two obvious defaults fail in opposite
directions. The **reseller** clawback is deliberately unchanged: a rep's commission is a share of
the money and is clawed back in proportion, per refund. The terms document (slice I) must state the
affiliate rule in these words.

### 2.7 Payouts in December, bank details not collected

The portal shows "payable". Until bank details exist, payable means *owed and un-sendable*. The
wording has to say so, or the first affiliate to see "£120 payable" in November will ask where it
is. One sentence, but it is the kind that gets left out.

### 2.8 Item 7's one-hour alert needs a definition and a cron

"Registered but didn't reach checkout within 1 hour" — *reached checkout* has no recorded event
today. The nearest facts are `GroupBilling.stripe_customer_id` (set when the Checkout session is
created) and the onboarding step state. And it needs a scheduled job: `vercel.json` already runs
five crons, so this is a sixth, not new infrastructure.

### 2.9 The test-only route through SMS verification

You asked for something that **cannot exist on production**. An env-gated bypass does not qualify —
a variable set wrongly on production opens it, and nothing would say so.

**Proposal: gate it on the database's own identity.** `lib/environment` holds an `Environment.kind`
marker (`production` | `test`) in the database, and it is the same marker `gatePrisma()` already
requires before any gate may write. A bypass that refuses unless `readEnvironment()` says `test`
cannot be enabled by a deploy, an env var or a typo — only by changing a row on production, which
is itself the thing the marker exists to make loud. `sendNotification` already consults this marker
and declines with `skipCode: 'test_environment'`, so the pattern and its refusal code exist.

---

## 3 — SLICES, IN ORDER, ONE COMMIT EACH

Each ends green with gates through the rendered screens, red-proved.

| # | Slice | Migration |
|---|---|---|
| **A** | **Wire the affiliate accrual.** `rewardPaidInvoice` called from `invoice.paid` beside the rep accrual; the 14-day hold as a derived predicate; the refund policy written down and the refund half wired (full refunds only, amended 2026-10-30); `REFUND_POLICY_UNDECIDED` deleted. Nothing user-facing. | none |
| **B** | **Split the switch.** `affiliate_signups_open` keeps its meaning for the offer; a new column for public joining. Engine Room gets both, labelled so neither can be mistaken for the other. | **1 additive** |
| **C** | **`affiliates.greasedesk.com` + the public page.** Middleware routing on the `er.` pattern, hero, terms card, reasons, four steps, FAQ, all figures from the settings through one resolver. Links to the apex carrying `?ref=`. | none |
| **D** | **Signup + email + SMS verification + instant approval.** Short form, `Rep` row with `party_type: affiliate`, email verify, SMS via the existing path with its existing limits, the test-environment bypass of 2.9, then code + link + QR. Creation-time case guard. | **1 constraining** (`lower(ref_code)` unique, affiliate rows) — *only after the collision check has been run* |
| **E** | **The portal.** Magic-link sign-in reusing `lib/rep-magic-link`, link/code/QR, referrals by garage name and status only, earnings in five states, the payee choice recorded, the December note. | **1 additive** (payee choice columns) |
| **F** | **Engine Room affiliates list.** Name, code, confirmed mobile, referrals, earnings; suspend/unsuspend. | none |
| **G** | **Alerts.** Recipient as a setting; the three event-driven alerts; the one-hour cron. | **1 additive** (`alert_email`) |
| **H** | **`legal-drafts/affiliate-terms.md`**, linked from signup and the portal. | none |
| **I** | **Personal codes for garage signups** (item 4) — last, because 2.3 needs your answers first. | possibly 1 additive |

### Migrations, named and classified

```
20261030090000_affiliate_public_signups_open     additive       slice B
20261030100000_affiliate_ref_code_case_unique    CONSTRAINING   slice D   ← needs the collision check first
20261030110000_affiliate_payee_choice            additive       slice E
20261030120000_programme_alert_email             additive       slice G
```

The constraining one carries the two-push rule: **code first, wait until production reports it,
then apply.** Four migrations across nine slices, and I will ask before each.

---

## 4 — WHAT YOU MUST ADD IN VERCEL

1. **Project → Settings → Domains → Add** `affiliates.greasedesk.com`.
2. Vercel will give a DNS record — a `CNAME` to `cname.vercel-dns.com` on the `affiliates` label at
   your registrar (the same shape as `er.`).
3. Nothing else. No environment variable: the host is matched in `middleware.ts`, like `er.`, and
   the deploy serves all three hosts from one project.

Two things worth knowing: the `gd_ref` cookie is already scoped to `.greasedesk.com`, so a code
picked up on `affiliates.` carries to the apex signup — that is why the subdomain works at all.
And `er.` currently 404s everything that is not the Engine Room; `affiliates.` will need the same
treatment in reverse, exposing only its own pages.

---

## 5 — DECIDED (owner, 2026-10-29). PLAN APPROVED.

1. **2.2 — payee choice recorded now; December payouts are BANK TRANSFER ONLY.** The choice is
   me / my garage / someone else. Garage account credit only later, if anybody asks for it — so the
   VAT and credit-balance questions of 2.2 are deferred, not answered.
2. **2.3 — one affiliate per person.** The `Rep` row is reused by email, one code whichever garage
   they signed up from. So the `@unique` email is not a problem to work around; it is the rule.
3. **2.3 — no separate weaker column, and a better design than the one I proposed.** A garage
   signup creates the personal code **INACTIVE**. The dashboard shows a one-click *"Activate your
   referral code"*, and THAT records real acceptance in `terms_accepted_at`. Nothing accrues for an
   unactivated code: a referral made before activation is still **attributed**, and is **credited
   from activation onwards**. The activation screen must state that rule, so nobody discovers it
   from a missing reward.
4. **2.4 — already answered.** The owner ran `check-ref-code-case.mjs` against production on
   2026-10-28 at 12:07: *"2 partner row(s): 2 rep, 0 affiliate. NO collisions."* Re-run it
   read-only immediately before the constraining migration as a final check; no need to wait on it.
5. **2.6 — write the FULL refund and chargeback policy into the terms, wire the refund half now,
   and put the chargeback half on the board against the Dispute work.**

Also agreed, confirming the recommendations in section 2:

- the switch splits into **"new affiliates can join"** and **"referred garages get the offer"**;
- **personal codes are always on** — neither switch gates them (2.1);
- **self-referral is checked at ACCRUAL as well as signup** (2.3);
- the **test-only SMS route is keyed on `Environment.kind`** (2.9);
- the **14-day hold is derived**, not stored (2.5);
- the portal **states that "payable" means owed but not sendable** until bank details exist (2.7).

`affiliates.greasedesk.com` is being connected in Vercel by the owner.

---

## 6 — WHAT CHANGED IN THE SLICES AS A RESULT

Slice A grows two clauses from answer 3 and one from the self-referral ruling: an **unactivated
code accrues nothing**, a reward is **credited from activation onwards**, and the "own or work for"
test runs at accrual. None of it needs a migration — `Rep.terms_accepted_at` already exists and
NULL already means "has signed no affiliate terms".

Slice I (personal codes) keeps its place at the end, but is now **activation** rather than
creation: the row and the code are minted at garage signup, and the dashboard's one-click
acceptance is the whole of the user-facing work.
