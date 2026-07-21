# Engine Room — Functional Specification

> The Engine Room is the **platform tier** of GreaseDesk: the operator-facing control plane
> that sits above every garage tenant. It runs on its own origin (`er.greasedesk.com`),
> its own actor class, and its own cookie jar. This document is the reference the remaining
> build works against. Where a section is marked **DESIGNED — NOT BUILT**, it is a
> committed intent, not shipped code; build it against this spec, prove it through the
> rendered page, and update the status legend when it lands.

---

## 0. Status legend

| State | Areas |
|---|---|
| **BUILT / GATED** | Auth foundation (three-actor class), the shell, origin isolation, Operators, Settings, the commission engine, **Rates** (the CommissionRate write surface), **attribution resolution** (`resolveAttribution` — ref → `TenantAttribution`), **minimal Rep identity** (model + `ref_code`), **operator 2FA (TOTP)**, **billing → commission wiring** (Stripe `invoice.paid`/`charge.refunded` → engine, test-mode, dormant until keys) |
| **NEXT** | The forecast dashboard, or Reps management UI — owner's call |
| **DESIGNED — NOT BUILT** | Tenant lifecycle (suspend / transfer-ownership / purge), the forecast dashboard, Reps management UI, the rep PWA portal, the Countries module, **tenant/rep 2FA**, **mandatory-2FA enforcement policy** |

"Built / gated" means: shipped to prod on `greasedesk.com` / `er.greasedesk.com`, served-build
verified after a buildId flip, and **proven by behaviour through the rendered page** — not just
by a passing API call.

---

## 1. Cross-cutting disciplines

These hold across every area. A slice that violates one is not done.

1. **Audit everything.** Every state change an operator makes is written to `SuperAdminAudit`
   with actor, target, action, reason, and before/after detail. No silent mutation of anything
   that matters (identity, role, ownership, money, lifecycle).
2. **Production-shaped from line one.** No demo scaffolding, no "we'll wire the real table later".
   Every slice writes to the real schema, on the real origin, gated by the real guards. Dev *is*
   prod; destructive tests use throwaway fixtures and tear them down, never real rows.
3. **Effective-dated config never moves history.** Rates, commission rates, attribution — all
   effective-dated. Changing a rate opens a new period; it never rewrites what a past period was
   computed against. History is immutable; the future is editable.
4. **One engine, many readers.** Each domain has exactly one computation chokepoint
   (`computeCommission`, `resolveHolidays`, the capacity/charged-labour libs, `fixedLineText`,
   `formatMoney`, …). Guards, forms, renders and reports all read *through* it. No parallel
   re-implementation of a rule anywhere.
5. **Guards proven by behaviour through the rendered page.** A gate is proven when the wrong
   actor gets a 404 on the live host and the right actor gets the function — demonstrated on the
   served build, not asserted in a unit test alone. Hidden nav link ≠ guard.

---

## 2. Boundary & auth architecture  — **BUILT / GATED**

### 2.1 Three actor classes

The NextAuth JWT carries `actorClass ∈ { tenant, operator, rep }`. **Absent = `tenant`**
(backward-compatible with every pre-existing session). Three CredentialsProviders authenticate
the three classes independently:

- `credentials` → tenant (the garage app)
- `operator` → Engine Room
- `rep` → reseller portal

An operator provider `authorize` rejects `INVITE_PENDING` and suspended operators, and stamps
`Operator.last_login_at` on success.

### 2.2 Undiscoverability

The platform surface must not merely be *forbidden* to the wrong actor — it must be *invisible*:

- Wrong actor class on any Engine Room page → **404** (not 403).
- Out-of-region tenant to a region-scoped operator → **404**.
- The operator-management surface returns **404 even to a valid non-owner operator** — maximally
  undiscoverable; a support operator cannot tell Operators management exists.

### 2.3 Origin & cookie isolation

`er.greasedesk.com` and the apex `greasedesk.com` have **separate cookie jars** by construction.
NextAuth default host-only cookies (`__Secure-` / `__Host-` prefixes, **no `Domain` attribute**)
mean an apex session and an Engine Room session never bleed into each other.

> **GUARDRAIL (in `[...nextauth].ts`):** never add a parent-domain `Domain` attribute to the
> auth cookies. Doing so would collapse the two jars and let a tenant cookie be presented on the
> operator origin. This is load-bearing isolation, not a nicety.

### 2.4 Middleware host→path rewrite

- On `er.greasedesk.com`: `/` rewrites to `/superadmin` (the front door renders the login form at
  the bare root when logged out, so the address bar never shows `/superadmin/login`); engine-room /
  auth / `_next` paths pass through; everything else 404s.
- On the apex: `/superadmin/*` 404s (the platform tier does not exist from the tenant origin);
  everything else passes through.

### 2.5 Guards (the operator equivalents of the tenant admin-guard chokepoint)

`lib/operator-auth.ts`:

- `requireOperatorApi(req, res, { minRole?, tenantId? })` — API guard; wrong class → 404.
- `requireOperatorPage(ctx, { minRole? })` — gSSP guard; returns `{ ok, op }` or `notFound`.
- `operatorTenantScope(op)` — region filter derived from the principal (region-scoped operators
  only ever see their regions' tenants).
- `roleAtLeast` / `erMinRole(path)` / `erNavFor(role)` / `operatorLanding(role)` — role ordering,
  per-path minimum role, role-filtered nav, and the post-login landing.
- Re-exports `leavesZeroActiveOwners` from `lib/owner-lockout.ts`.

`lib/rep-auth.ts`: `requireRepApi` / `requireRepPage` — the same shape for the rep class.

---

## 3. The three operator roles  — **BUILT / GATED**

| Role | Scope | Sees / does |
|---|---|---|
| **Owner** | Global, all regions | Everything. Only role that manages operators, edits Rates, transfers/purges tenants, edits Countries. |
| **Country manager** | Their assigned region(s) | Tenants and reps within region; no operator management, no global config. |
| **Support** | Their assigned region(s), read-lean | Tenant support functions; no money config, no operator management. |

Role ordering is total (`owner > country_manager > support`); `erMinRole(path)` maps each surface
to its floor and the guard enforces it server-side. Region scope is enforced by
`operatorTenantScope`, not by the UI.

---

## 4. The shell  — **BUILT / GATED**

`components/layout/EngineRoomLayout.tsx`. Dark slate shell, visually distinct from the light tenant
workspace so an operator is never in doubt which plane they're on. Left rail = `erNavFor(role)`
(nav items filtered by role, so the link is absent for the wrong role **and** the page 404s them).
**Settings** and **Sign out** are pinned to the bottom; sign-out returns to the Engine Room login,
not the apex.

Front door: `pages/superadmin/index.tsx` reads the session principal directly — operator → role
landing; wrong class → 404; logged out → renders `OperatorLoginForm` at the bare root (with a
"Forgot password?" link). This direct-session read is what lets logged-out (→ login) and
wrong-class (→ 404) diverge from the same URL.

---

## 5. Operators  — **BUILT / GATED**

Owner-only, server-enforced, fully audited. `pages/superadmin/operators.tsx` +
`pages/api/superadmin/operators.ts`.

### 5.1 Functions

- **Create / invite.** Owner enters email, name, role, regions. The operator is created with
  `passwordHash = 'INVITE_PENDING'` and an invite token (5-day). The **one-time set-password link
  is surfaced on screen** (works even when the mailbox doesn't exist yet) and emailed when Resend
  delivers. The operator sets their own password via `/api/superadmin/operator-set-password` →
  `pages/superadmin/set-password.tsx`; the owner never sees it.
- **Edit role / regions.** Inline; owners have "all" regions (region field n/a).
- **Suspend / un-suspend.** Per-row control, always visible (compact 6-column table, action in its
  own column). Suspend prompts for a reason. A suspended row reads visibly as **Suspended** (red
  pill, red-tinted row) and cannot log in; un-suspend restores access.
- **No delete.** Operators are suspended, never removed, so the audit trail of what they did
  survives.

### 5.2 Lockout invariants (`lib/owner-lockout.ts`)

Pure function `leavesZeroActiveOwners(activeOwnerIds, targetId)` is the single source of truth:

- An operator **cannot suspend or demote themselves.**
- The **last active owner cannot be suspended or demoted** — the platform can never be left with
  zero active owners.

The refusal message is surfaced **inline** on the row action, not swallowed into a generic error.

### 5.3 Tokens (`lib/tokens.ts`)

`makeInviteToken()` (5-day) / `makeResetToken()` (1h) / `hashToken()`. Reset entry point:
`pages/superadmin/forgot-password.tsx` + `/api/superadmin/operator-forgot-password`
(enumeration-safe — always the same generic confirmation, re-mints the token, emails the link,
never returns it in the response).

### 5.4 Audit

`SuperAdminAudit` was extended for operator targets: `target_group_id` made nullable, plus
`target_operator_id` and `reason`. Every create / role / regions / suspend / unsuspend writes an
audit row with actor, target, action, reason, and before/after detail.

---

## 6. Settings (operator self-account)  — **BUILT / GATED**

`pages/superadmin/settings.tsx` + `pages/api/superadmin/operator-account.ts`. **All roles.** Acts
on the **logged-in operator's own record only** — the API reads the actor from the session and
writes to `actor.userId`; it takes no target id, so an operator can never edit anyone else here.
Role / region / suspend stay owner-only on the Operators screen, deliberately not here.

- **Name** — change own display name.
- **Email** — current password required (identity change); uniqueness enforced (P2002 → 409);
  the **old address is notified** on change.
- **Password** — current password required; mirrors the tenant change-password.

**Flagged limitations (deliberate, for later):**

- No verify-new / notify-old two-step for email — there is no tenant pattern to mirror (tenants
  only have change-password), so full new-address confirmation is **not** built; the simple
  version (change directly + notify the old address) ships, and the screen says so honestly.
- Operators have **no `sessions_valid_from` floor**, so a password change does **not** revoke other
  operator sessions; the JWT is id-based, so the caller stays signed in.

---

## 6a. Two-factor authentication (operator)  — **BUILT / GATED**

TOTP 2FA on the Engine Room login — hardening the platform master key (the one credential that can
touch every tenant). Google Authenticator / any RFC-6238 app. Operators only this slice; the mechanism
is actor-agnostic so tenant/rep 2FA extend it without a rebuild.

- **Crypto in-house** (`lib/totp.ts`, RFC 6238 over `node:crypto`, SHA1/6-digit/30s) — no dependency in
  the verification path; validated against the RFC test vectors. Only `qrcode` (render-only) was added.
- **Storage is generic** — `TwoFactorSecret` + `TwoFactorRecoveryCode` keyed by `(subject_type,
  subject_id)`, **not** FK'd to one identity table. Extending to `subject_type='tenant'|'rep'` needs no
  schema change. `lib/two-factor.ts` is the sole chokepoint (enrol / confirm / verify / disable / reset).
- **The five pieces.** (1) *Enrolment* in Settings: QR + secret text; **`enabled` flips true only after a
  confirming code round-trips** — never enable a secret the operator can't prove. (2) *Recovery codes*:
  10 one-time codes, shown once, stored sha256-hashed. (3) *Verification at login*: enforced **server-side
  in the operator `authorize()`** — once enrolled, password alone yields no session; a valid TOTP **or** an
  unused recovery code is required (a login preflight only decides whether to show the code field). (4)
  *Disable / reset*: self-disable needs password + a code; an **Owner resets another operator's 2FA** from
  the Operators screen (the lost-device recovery path). (5) *Policy*: available and self-enrolled, **not yet
  mandatory** — see designed-not-built.
- **Audited**: enrolment, disable, owner-reset, and every failed-2FA-at-login write `SuperAdminAudit`.
- **Lockout guards (proven)**: enrol-without-confirm leaves 2FA off; a recovery code logs in once then is
  consumed and rejected on reuse; owner-reset restores password-alone login. **Sole-owner recovery story**
  (there is no higher tier to rescue the sole owner): the escape hatches are, in order — (a) the recovery
  codes, (b) if those are also lost, a **direct-DB delete of the `TwoFactorSecret` row** (the operator holds
  the database credentials, which is the higher tier for the sole owner). Both proven on throwaways.

**Designed — not built:** tenant/rep 2FA (same `lib/two-factor` with a different `subject_type`); a
**mandatory-2FA enforcement policy** (forcing all operators to enrol) — a deliberate later decision, not
built while there is one real operator. Also noted: encryption-at-rest of the TOTP secret (stored base32
as-is today; a DB leak yields the secret but not the bcrypt password, so 2FA still holds unless both leak).

---

## 7. Tenants (lifecycle)  — **DESIGNED — NOT BUILT**

The operator's view onto the garage tenants, region-scoped via `operatorTenantScope`. Beyond the
existing list (`/superadmin/tenants`, and the SuperAdmin Archive/Purge already present), the
lifecycle to build:

- **Suspend tenant.** Soft — the tenant becomes read-only / locked out without data loss. Audited
  with reason. Distinct from operator suspend; touches the *tenant group*, never any operator or
  the tenant's own users.
- **Transfer ownership — audited.** Reassign the owning user of a tenant group. This is an
  identity-critical action: it moves control of a live garage. Fully audited (from-owner,
  to-owner, actor, reason), and it must satisfy its own "don't orphan the group" invariant
  (never leave a tenant with no owner), mirroring the operator last-owner guard.
- **Purge — hard, time-gated.** Permanent destruction of a tenant and its data. **Hard-blocked
  until 12 months after archival** — a tenant cannot be purged until it has been archived for a
  full year. The block is a guard, not a UI convenience: the API refuses regardless of surface.
  Ordered teardown (respect FK order), fully audited before the rows disappear.

> Every lifecycle action writes to `SuperAdminAudit`. Suspend ≠ archive ≠ purge: reversible lock,
> reversible cold-storage, irreversible destruction — three distinct states, three distinct guards.

---

## 8. Commission engine  — **BUILT / GATED** (layer 2, dormant)

`lib/commission.ts`. The money the platform pays reps for the tenants they bring. One chokepoint,
effective-dated, injected clock, provably correct.

- **`computeCommission` — the single chokepoint.** Every reader (dashboard, ledger, rep portal,
  future payout run) computes commission *only* through this function. No parallel formula.
- **`CommissionRate` — effective-dated.** A rate has an effective window; changing a rate opens a
  new period and never rewrites a past one. History is computed against the rate that was in force
  then.
- **`TenantAttribution` — the join.** Links a tenant to the rep who is attributed it (see §10).
  Commission flows from attribution: no attribution, no commission.
- **`CommissionEntry` — the ledger.** The append-only record of computed commission, one engine
  writing, many readers reading.
- **30-day arrears.** Commission on a tenant's payment is earned on a 30-day-arrears basis — a
  payment settles, then its commission becomes due 30 days later (protecting against immediate
  churn / refunds).
- **Clawback.** If the underlying revenue reverses (refund, chargeback, cancellation inside the
  window), the commission is clawed back — a negative entry, not a deleted one; the ledger stays
  append-only and auditable.
- **Injected clock.** The engine takes its clock as a parameter (never `Date.now()` internally),
  so arrears, effective-dating and clawback windows are testable at any instant.
- **Proven: 9 cases.** `scripts/commission-fixed-clock-gate.mjs` exercises the engine against a
  fixed clock across nine scenarios (rate-in-window, rate-change-mid-period, pre-arrears,
  post-arrears, clawback-inside-window, clawback-after, no-attribution, effective-date boundaries,
  ledger append-only) and passes.

### 8a. Billing → commission wiring  — **BUILT / GATED** (test-mode; dormant until keys)

`lib/commission-billing.ts` + two cases in `pages/api/stripe/webhook.ts`. The first time the money loop
runs from a card charge to a ledger entry. The Stripe webhook (already signature-verified against
`STRIPE_WEBHOOK_SECRET`, `event.id`-deduped) now also feeds the engine — it does **not** compute
commission, it maps the event onto a `Payment`/`Refund` and calls `accruePayment` / `clawbackRefund`.

- **Events (confirmed):** `invoice.paid` → accrual; `charge.refunded` → clawback. (`invoice.payment_succeeded`
  is redundant; `credit_note.*` is an accounting doc — neither is used.)
- **Join:** Stripe customer → tenant via `GroupBilling.stripe_customer_id → group_id` (never pass the
  customer to the engine). **Attribution:** `resolveAttribution` runs on the collected payment, so a
  tenant whose `?ref=` only now matches a rep still attributes; an unattributed tenant is a **safe
  no-op**, not an error.
- **Trial:** the engine trial-gates on `Group.trial_ends_at` (kept in sync from the subscription's
  `trial_end`) — a during-trial `invoice.paid` accrues nothing; the first post-trial one is the first
  accrual.
- **Idempotency, two layers:** `StripeEvent.event_id` (webhook) **and** `CommissionEntry.source_ref` =
  the Stripe **invoice id** (accrual) / **refund id** (clawback) — the payment-object identity, so a
  re-delivered or duplicate-typed event can never double-write.
- **No live Stripe API calls in the money path** — reads the event payload + DB only.
- **Proven** with synthetic Stripe-signed events (valid accepted / forged rejected; £35 accrual to the
  rep via the engine at the real GB/GBP rate; full + partial clawback netting; resend → no duplicate;
  pre-trial → no accrual), and the engine's 9-case suite still passes unchanged. Real test-card / 3DS /
  `stripe events resend` acceptance is `docs/billing-commission-testmode-runbook.md`.
- **Correction to an earlier claim:** the engine does **not** gate accrual on a 30-day timer. Accrual is
  immediate at collection (`status:'pending'`); the "arrears/payout window" lives in entry status —
  a pending accrual becomes `paid` at a **payout run**, and clawback nets against a still-`pending`
  accrual or carries a debt when already `paid`. **The 30-day payout-eligibility timer is the payout
  run — designed-not-built.** This wiring drives accruals + clawbacks correctly; it does not implement
  that timer.

**Still pending:** the **live cutover** (real keys, real cards) — a separate deliberate step; the
**payout run** (flips `pending → paid` after the arrears window, and pays).

The engine + wiring are correct and gated; **dormant in prod until Stripe keys land** (`getStripe()` null
→ the webhook 503s), so nothing pays anyone yet.

---

## 9. Rates  — **BUILT / GATED**

Owner-only, effective-dated (§1.3). The write surface over the `CommissionRate` table that the
engine (§8) already reads — until this shipped, only fixtures wrote it.
`pages/api/superadmin/rates.ts` + `pages/superadmin/rates.tsx`.

- **Append-only-forward.** A new rate's `effective_from` must be strictly after the latest existing
  boundary for its (country, currency, tier) key. You extend the timeline forward; you never splice
  a rate into the past. Amending a rate = adding a new forward-dated row — the prior row is never
  touched, so a payment stays frozen at the rate in force when it was collected.
- **The overlap rule, made physical.** For a key the effective-dated rows form a clean,
  non-overlapping timeline: every `effective_from` boundary is unique. Enforced at the API *and* by
  a `@@unique([country_code, currency, tier, effective_from])` index (it replaced the non-unique
  one; same leading columns still serve `resolveRate`). Same-date = overlap → refused; earlier date
  = not-forward → refused.
- **The only mutable rows are future + unreferenced.** A row whose `effective_from` is still in the
  future AND that no `CommissionEntry` was computed against can be corrected (PATCH) or removed
  (DELETE). Anything in force, past, or referenced is frozen; the remedy there is a new forward
  amendment, never an edit. (The admin "in force yet?" question is the one legitimate wall-clock read
  in the money path — the engine itself never reads the wall clock; it resolves against the payment's
  `collected_at`.)
- **Audited.** `rate.created` / `rate.corrected` / `rate.removed` to `SuperAdminAudit` (both target
  ids null — rates target neither a tenant nor an operator; the key is the snapshot). No audit-schema
  change was needed.
- **Gated against the engine, not just the table.** Rates written through the deployed API were read
  back by `computeCommission` on a synthetic tenant across a 2026→2027 amendment boundary: the 2026
  payment stayed frozen at the old rate, the 2027 payment took the amendment — history did not move.
  Overlap/back-date refusals and non-owner 404 proven on the live host; the freeze timeline
  (in-force = frozen, future = correctable/removable) proven through the rendered page.

The subscription price the tenant pays is a separate, future Rates concern; this slice is the
commission-rate half.

---

## 10. Attribution capture & resolution  — **BUILT / GATED**

How a tenant becomes attributed to a rep, feeding `TenantAttribution` and therefore the commission
engine. The spine now runs end to end: `?ref=code → gd_ref cookie → Group.signup_ref → resolve →
TenantAttribution → computeCommission`.

**Capture (built 18 Jul, live).** `?ref=code` is stashed into a first-party `gd_ref` cookie at first
touch (`pages/_app.tsx`, sanitised + capped) and persisted to `Group.signup_ref` at signup
(`register-garage.ts`). Dormant until this slice.

**Resolution (`lib/attribution.ts` — the chokepoint).** `resolveAttribution(group)` matches a `Rep`
by exact `ref_code = signup_ref`; on a match with no existing active attribution it writes the rep as
party (`party_type='rep'`, `role='referrer'`, `share_bp=10000`, `source='ref_param'`,
`effective_from` = the group's signup date). The brief's "role rep" maps to `party_type='rep'` — the
schema's `role` vocabulary is `referrer|regional`, and the engine keys commission off
`party_type:party_id`, not `role`.

- **The ref is the source; attribution is derived.** `Group.signup_ref` is the captured truth of who
  referred, and resolution **never drops or overwrites it** — even after a `TenantAttribution` row is
  written. A signup that arrives before its Rep loses nothing.
- **Two triggers.** (1) *At signup* — `register-garage.ts` calls `resolveAttribution` best-effort
  after the group is created (never fails a signup; no Rep yet → deferred). (2) *Deferred* —
  `resolveAttributionsForRep(repId)` resolves every group that was waiting on that ref_code, called
  when a Rep is created; plus an owner-gated sweep, `resolveAllPending`, exposed at
  `POST /api/superadmin/resolve-attributions` (any non-owner → 404, audited `attribution.resolved`).
- **Idempotent.** Re-running never duplicates — an existing active rep-attribution for the same
  (group, rep) is a no-op. A 100% ref attribution is refused when the group already carries a
  *different* active attribution (would break the engine's Σ=10000 invariant).
- **No wall-clock.** `effective_from` is the group's signup date, not `now`.
- **Gated against the engine.** A throwaway Rep `TESTREP` + Group `signup_ref=TESTREP` resolved to a
  `TenantAttribution` that `computeCommission` then paid at the GB/GBP rate — the first end-to-end run
  of ref → attribution → commission. Deferred path (ref before Rep) and idempotency proven; `signup_ref`
  intact throughout.

**Still to come:** a later "correction opens a new attribution period" flow (effective-dated
hand-over via `ended_at`) for when an operator re-attributes a tenant; today resolution writes the
first attribution, and the conflict guard refuses to silently stack a second.

---

## 11. Engine Room forecast dashboard  — **DESIGNED — NOT BUILT**

The operator landing for owners/CMs: the platform's own financial glance, region-scoped.

- Live tenant counts by lifecycle (active / trialing / lapsed / archived).
- MRR / ARR and its trajectory.
- **Forecast:** committed commission liability (from `CommissionEntry`, including arrears not yet
  due and expected clawback exposure), and projected platform net.
- Region-filtered by the operator principal — a CM sees their region's forecast, an owner sees all.
- Reads *through* `computeCommission` and the capacity/charged-labour libs; it renders numbers, it
  does not recompute rules.

---

## 12. Reps management  — **DESIGNED — NOT BUILT** (minimal Rep identity exists)

The **`Rep` model already exists** — `id, email @unique, passwordHash, name, ref_code @unique,
country_code, payout_details, status, timestamps` — enough for §10's `resolveAttribution` to match a
captured ref against. What's **not** built is the management *UI/API*: no owner surface creates,
invites, edits, or suspends a Rep yet, so Rep rows are made by fixtures/scripts for now. When that
surface lands, its Rep-create path must call `resolveAttributionsForRep(newRepId)` so signups that
arrived first resolve immediately.

Owner + Country-manager surface (region-scoped). The rep equivalent of Operators:

- Create / invite a rep (invite-token flow, mirror of the operator one) — **must** trigger deferred
  attribution resolution on create (§10).
- Assign region(s) and the applicable `CommissionRate` (effective-dated).
- Suspend / un-suspend (a suspended rep cannot log in to the portal; attribution and past
  commission survive — no delete, same discipline as operators).
- See a rep's attributed tenants and their commission ledger (read through `computeCommission`).
- Fully audited.

---

## 13. Rep portal (phone-first PWA)  — **DESIGNED — NOT BUILT**

The reseller-facing app, `rep` actor class, its own origin discipline and cookie jar (§2). Built
phone-first as an installable PWA (mirror of the tenant `/m` spine's install/offline discipline,
scoped to what a rep needs).

- **Click-sign agreement, country-versioned.** On activation a rep click-signs the reseller
  agreement. The agreement text is **versioned per country** (the GB agreement differs from the IE
  one); the signed version + timestamp + country is recorded immutably. A rep is not activated —
  and earns no commission — until the country-correct agreement is signed.
- **My attributions.** The tenants attributed to this rep, their status, and the commission earned
  (read through `computeCommission`; arrears and clawback shown honestly — earned-not-yet-due vs
  paid vs clawed-back).
- **Referral link.** The rep's `?ref=` link to share (feeds §10).
- No money-movement in the portal (payouts are a platform-side run); the rep sees what they've
  earned, they don't trigger payment.

---

## 14. Countries module  — **DESIGNED — NOT BUILT**

The per-country platform-config **spine**. Holidays, localisation and onboarding all *inherit* from
it — Countries is config; the things that read it are flows over that config, not new config.
**Owner-only to edit.**

### 14.1 Country record

A country (GB, IE, US, …) carries:

- **Currency** — exactly one per country. GB → GBP.
- **Tax model type** — `VAT | sales-tax | none`. This is a **model, not a rate**: it selects which
  tax *engine* applies, not a percentage. GB → VAT.
- **Tax rules** — keyed to the model (the VAT rules for a VAT country; the sales-tax rules for a
  sales-tax country). A rate lives inside the rules; the model decides which rules are even
  meaningful.
- **Active status** — `live` (fully supported) or `seeded-not-live` (route reserved, config
  stubbed, marked unsupported).

### 14.2 Subdivisions

A subdivision within a country differs from its parent in **exactly two things: public holidays and
URL prefix.** Nothing else — a subdivision shares the country's currency, tax model and tax rules.

- **GB is ONE country with subdivisions**, not four countries:
  `england-and-wales` (split to `eng` / `wal` if/when needed), `scotland`, `northern-ireland`.
  They **share GBP and VAT**; they **differ only in public holidays and front-facing URL prefix.**

### 14.3 URL prefixes

- **No `/uk` prefix — dropped deliberately**, because UK public holidays differ per home nation; a
  single `/uk` would force one holiday calendar onto four nations that don't share one.
- URL prefix sits at **subdivision level** for GB: `/eng`, `/sco`, `/wal`, `/ni`.
- URL prefix sits at **country level** where there are no meaningful subdivisions: `/ie`, `/us`.

### 14.4 (10a) Public Holidays

- **`HolidayTemplate`** keyed by **country + subdivision**, owner-seeded at the platform level.
  Tenants inherit the template for their country+subdivision.
- **`resolveHolidays(country, subdivision, range)` — the chokepoint.** Resolves to:
  **templates ∪ tenant-additions − tenant-suppressions** over the requested range. A tenant can add
  a local closure and suppress a template day, but the template is the seeded baseline.
- It feeds **both capacity and the diary** — the same resolved set drives the sellable-hours
  capacity model *and* the booking diary. This **closes the deferred gap** where the diary currently
  shows bank holidays as bookable: once `resolveHolidays` feeds the diary, a bank holiday is closed
  by construction in both places.
- **Open decision to resolve before building:** does `subdivision` live on **Group** or on **Site**?
  A multi-site tenant could straddle subdivisions (a Scottish site and an English site under one
  group), which argues for Site; a single-subdivision tenant argues for Group. Resolve this first —
  it determines the key `resolveHolidays` is called with.

### 14.5 (10b) Localisation

- Each **country** carries: currency, tax model, tax rules, locale.
- Each **subdivision** carries: public holidays + URL prefix.
- `/us` is **seedable-not-live**: the route is reserved, the sales-tax model is stubbed, and it is
  **marked unsupported** — the presence of a `/us` route must **not** imply that US tax handling
  exists. Seeding a country is not the same as supporting it.

### 14.6 (11) Onboarding flows — per country, per actor

Onboarding **reads** the Countries config; it is a **flow over the config, not new config.**

- **Garage Tenant.** Country / subdivision selection → localised steps.
  - GB → VAT registration step + England-&-Wales holidays defaulted.
  - IE → euro + Irish VAT + Irish holidays.
  - The step set is derived from the selected country's tax model + the subdivision's holidays.
- **Reseller Rep.** `?ref=` → **country-versioned click-sign agreement** (§13) → rep activated →
  attribution wiring readied (§10). The agreement version presented is chosen by the rep's country.

---

## 15. Map of the surface

| Path (on `er.greasedesk.com`) | Role floor | Status |
|---|---|---|
| `/` (front door / login) | public | built |
| `/superadmin/dashboard` | support | shell built; forecast content designed |
| `/superadmin/tenants` | support (region-scoped) | list built; lifecycle designed |
| `/superadmin/operators` | owner | built |
| `/superadmin/reps` | country_manager | designed (Rep *model* built) |
| `/superadmin/rates` | owner | built |
| `POST /api/superadmin/resolve-attributions` | owner | built |
| `/superadmin/settings` | any operator | built |
| `/superadmin/set-password`, `/superadmin/forgot-password` | public (token) | built |
| Countries admin | owner | designed |
| Rep portal (separate origin, `rep` class) | rep | designed |

---

_This spec is the reference for all remaining Engine Room slices. When a designed area ships,
move it in the §0 legend and fill in its "built" details here — the document and the code advance
together._
