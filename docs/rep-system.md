# The rep system

**Status: partly built, deliberately dormant.** Revised 2026-09-08.

This is the design document for the sales-rep half of the platform: who introduces a garage,
what we owe them for it, what evidence stands behind that, and how they get paid. It exists
because the earlier versions of it lived only in conversation transcripts, which is not a place a
decision can be found again.

Everything here that is BUILT says so and names the module. Everything that is not says
`NOT BUILT`, in those words, so a reader never mistakes a description of the intent for a
description of the code.

---

## 1. The three actors

BUILT — `lib/rep-auth`, `lib/operator-roles`, `pages/api/auth/[...nextauth]`.

| actor | identity table | how they sign in | `actorClass` |
|---|---|---|---|
| tenant | `User` | `/admin/login` | `tenant` |
| operator | `Operator` | `/superadmin/login` (2FA enforced) | `operator` |
| rep | `Rep` | `/rep/login` | `rep` |

A rep is not an operator and not a tenant user. The three carry different JWT shapes: only the
tenant branch sets `group_id`, which is why `requireTenantApi` refuses the other two by
construction rather than by a check somebody has to remember.

Operator roles are `support` < `country_manager` < `owner`, with a `regions: string[]`. The Engine
Room nav and every screen's own guard read the same role map, so a hidden link is never mistaken
for a guard.

---

## 2. Attribution — who introduced this garage

BUILT — `lib/attribution`, `TenantAttribution`.

A `?ref=<code>` on the marketing site is stashed (consent-gated) and resolved at signup into a
`TenantAttribution` row: `(group, party_type, party_id, role, share_bp, effective_from, ended_at)`.

It is a JOIN, not a field on the tenant, because a garage can attribute to a rep AND a regional
manager at once, with `share_bp` splitting one payment's commission between them. Active shares
sum to 10000. Effective-dating plus `ended_at` means a territory hand-over applies the right split
per period rather than rewriting the past.

`Rep.signup_ref` is the immutable source. Creating a rep must call `resolveAttributionsForRep`, or
garages that signed up under a code before the rep row existed stay unattributed.

---

## 3. Commission — one amount, and it is £30

BUILT — `lib/commission`, `CommissionRate`, `CommissionEntry`, `CommissionRefusal`.

**£30 per attributed garage per collected month.** One tier (`thereafter`); the twelve-month taper
was retired on 2026-09-06. Rates are effective-dated: the rate for a payment is the latest row for
`(revenue_stream, country, currency, tier)` with `effective_from ≤ collected_at`. Amendments are
new forward rows; existing rows are never updated, so historical commission is frozen at the rate
in force when the money was collected. A DB-unique index on the boundary date makes that timeline
physical.

**REMOVED 2026-09-08 — the reduced rate.** `amount_unvisited_pennies` held £12.50 for a month
whose visit did not happen. There is no £12.50. **A garage-month is either paid at £30 or held.**
The column is dropped rather than nulled: NULL there already meant "this row predates the visit
gate", so nulling the row written *for* that gate would have been a lie in the one place the
schema is meant to be honest. Dropping was safe because `CommissionEntry` had zero rows — no
`rate_id` was frozen anywhere. **That window closed at the first accrual.**

The engine REFUSES rather than invents: no rate, shares that do not sum to 10000, a tenant it
cannot load. The refusal is recorded in `CommissionRefusal` — operator-only, deliberately not
`AuditLog`, because what we pay a rep for a signup is not the garage's business, and deliberately
not a zero-value entry, because every reader of the ledger adds entries up.

Accrual and clawback are wired to Stripe: `invoice.paid` accrues, `charge.refunded` claws back.
The clawback reads the ACCRUAL ENTRIES, not a recomputation — a territory hand-over or a rate
amendment between the two would otherwise reverse a figure that was never booked, against a party
who was never paid.

---

## 4. The visit — evidence, not a control

BUILT — `lib/rep-visit`, `RepVisit`, `RepVisitAnswer`, `RepLead`, `RepVisitNote`.

A visit is evidence that somebody turned up. The garage's screen displays a rolling QR; the rep's
phone reads it. The code is a TOTP step against a per-tenant secret, valid for its step ±1, and
**single-use** — `@@unique([group_id, code_step])` — because a screenshot forwarded inside the
window is the whole attack. It does not defeat a garage that wants to help a rep cheat; it defeats
a rep filling in a form at home, which is the behaviour worth stopping. At a £30 difference this
is not a budget for location tracking.

**The rule**, pure and proven on a fixed clock: one visit per calendar month AND at least fourteen
days since the last that counted. Neither clause is enough alone — month alone pays twice for the
31st and the 1st; fourteen days alone pays three times inside one month. Everything is computed on
civil dates in the site's timezone and the satisfied period is FROZEN onto the row at write time.

A visit that satisfies no month is still recorded, with `satisfies_period` NULL, and does not
anchor the next window — otherwise a keen rep locks themselves out by turning up twice.

**CHANGED 2026-09-08 — the visit no longer decides an amount.** With one rate, `RepVisit` is an
input to a human judgement, not a control on money. It never withholds anything by itself.

`monthNeedsVisit` was a PRICING rule — it stopped the reduced rate being charged for a month in
which a visit was arithmetically impossible. It is now a PRESENTATION rule, and it is the
predicate that gives the manager's list its third state. A garage that joined on the 28th showing
as "no visit" beside nineteen real misses is twenty conversations where there should be nineteen.

- `visited` — a visit satisfied this month
- `not_visited` — one was expected and did not happen
- `not_expected` — the garage was active for fewer than fourteen days of the month

Operator-recorded visits exist for the flat tablet: `source: 'operator'` with a mandatory coded
reason from a closed set (`screen_unavailable`, `no_one_could_sign_in`, `scan_failed`,
`code_expired`). Every value is a case where the rep WAS THERE — "could not attend" and "garage
closed" are deliberately absent, because a visit nobody attended is not a visit with a reason. Any
sentence goes in `RepVisitNote`, which leaves with the tenant on a purge; the code stays, because
it is the audit answer and it names nobody.

The four answers a rep writes up (app working, are they using it, what's missing, and the payments
lead) are separate rows: `RepVisitAnswer` and `RepLead`, both 0..1 per visit. That split is what
makes `RepVisit` insert-only by construction — there is nothing on it to update. Three-state
throughout with `not_asked` as a VALUE on a NOT NULL column and a nullable `_at` carrying the
absence, following `lib/due-items`. A visit with no answers is still a visit: **missed** (no scan)
and **incomplete** (scanned, not written up) are two lists and must never merge.

---

## 5. Payout — held by default, released by a person

NOT BUILT. Nothing in `lib/` or `pages/` sets `CommissionEntry.status = 'paid'` or writes
`payout_id`; only a gate simulates it. Held-by-default is today the de facto state by ABSENCE, and
the design below is what makes it a decision.

**Nothing is paid without a human release.** Money stays pending indefinitely. "What we owe" and
"what we have approved" are different questions and must be answerable separately.

`pending` currently means "nothing has happened to this yet". Under the release it must mean "we
owe this and nobody has approved it". Those coincide now and diverge the moment a release exists,
so the third state belongs on the same column — `pending` → `approved` → `paid` — rather than in a
second column that can disagree with the first.

**The release is a monthly act by the area manager.** Their screen lists their reps; opening a rep
shows that rep's garages with tenure, last visit date, and this month's visit state (the three
above).

**Per garage, not per rep.** 90 of 100 visited is a working month — release all 100. 20 of 100
releases 20 by default and the manager decides on the rest after a conversation. So a release can
pay for a month with no visit; that is the point of a human holding it.

Each line defaults to its visit state; the manager overrides any line with a reason, audited. The
release is a RECORD, not a flag — the manager, the moment, what they were shown, what they
decided. Setting a status alone would lose the reasoning, and the override needs somewhere to
live. It keys on `(group_id, period)` because it is about the garage; the money is about the
parties, and `share_bp` may turn one release into two entries.

**The escalation ladder is removed.** There is no automatic consequence for a missed visit, and
losing a garage was its third rung. Nothing in the code changes, because the ladder was never
built — but the signal it computed has no home unless the release screen carries a multi-month
view. A month at a time cannot show that a rep has stopped working, so the list should carry
consecutive unvisited or unreleased months beside the tenure.

**Where it lives: a section of the Engine Room, not its own portal.** The role ladder, region
scoping, 2FA, the nav-and-guard pairing and `SuperAdminAudit` all already exist there; a separate
portal duplicates every one. An area manager maps onto `country_manager` with regions to begin
with. A fourth role earns its place only if an area manager must NOT see what a country manager
sees.

`CommissionEntry.shown_as_visited` (renamed 2026-09-08 from `visited`, which described a rate
branch that no longer exists) freezes the picture the manager was shown at release. Re-deriving it
later would show a different one, because an operator-recorded visit can be added afterwards.

---

## 6. The rep invoice

NOT BUILT. Reps are self-employed and invoice GreaseDesk monthly. The portal generates it from a
template so there is nothing to type.

The rep enters their own details once; ours are baked in. Lines come from what the area manager
released — the released entries ARE the invoice lines, which is what keeps the invoice and the
ledger from disagreeing. `Rep.payout_details Json?` is the wrong home for anything the template
renders: opaque, unvalidatable, un-gateable. Address, VAT number and bank details want columns.

**Numbering** — `IK-0526-0001-GD-UK`: initials, signup month and year, four-digit sequence, `GD`,
region. Separated for legibility; fourteen unbroken characters is unquotable on a phone. The
stored value is a counter and the separators are a render, exactly as `lib/invoice-number` already
splits `assignInvoiceNumber` from `formatInvoiceNumber`.

**The collision, and why a warning is not enough.** If each rep's sequence starts at `0001`, two
reps with the same initials who signed up in the same month produce IDENTICAL numbers,
indefinitely — not a near-miss, the same string on two people's accounts-payable documents. Flag
it at rep creation, but make it structural: a unique index on the rendered prefix
(initials + signup month), so the second rep is refused by the database and the operator resolves
it then. The index is the rule; the form is the courtesy.

**`UK` is not an ISO code.** `ENABLED_COUNTRIES` is `['GB']` and `Rep.country_code` is alpha-2. The
number must either map `GB → UK` at ONE render chokepoint that says why, or say `GB`. What must not
happen is a second country vocabulary that transforms one side and not the other.

**VAT.** The template handles a registered rep adding 20% and showing their VAT number. Most reps
will be under the threshold: they show NO VAT line at all — not a zero VAT line, which reads as
"VAT applies at 0%" and is a different claim. The VAT number is nullable and its NULL means "not
registered".

**"Send" marks it submitted; it does not email a PDF.** An email is a copy, the payable is the
record. If send means email, what we owe lives in an inbox and reconciliation is manual. Submitted
means it appears in the Engine Room as a payable, comparable line by line against what was
released. Email the PDF as well if the rep wants a copy — through `sendNotification`, which writes
a `NotificationLog` row and honours opt-outs — but as a delivery, never as the mechanism. The same
distinction the invoice artifact already makes.

---

## 7. What is deliberately not decided

- **How the area manager's overrides are coded.** A closed set plus prose, on the
  `UNSCANNED_REASONS` pattern — but the set itself is not written.
- **Whether an area manager is `country_manager` or a fourth role.**
- **Whether `RepVisit` should join the tenant-purge sweep.** It stays today, as the ledger's
  supporting document, and `purge-completeness-gate` names it.
- **Anything about rep termination, territory reassignment, or clawback of a released month.**
