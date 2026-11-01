# Deferred slices

Work that has been scoped and consciously *not* built, with the reasoning, so the decision can be
revisited on evidence rather than rediscovered from scratch.

---

## Out-of-hours work — including bank holidays

**The gap.** Work charged outside the site's trading hours is counted in the numerator of
utilisation but has no matching denominator. `getAvailableHours` builds capacity from rostered days
× contracted hours, and a rostered day is a weekday in the site's `open_days`. A Saturday callout at
a Mon–Fri site therefore contributes **charged hours with no sellable hours behind them**, which can
push utilisation above 100% — a number that reads as an error rather than as the real signal
(overtime), and which silently breaks the "100% = target by construction" property.

**BANK HOLIDAYS ARE THE SAME DEFECT THROUGH A DIFFERENT DOOR**, and a worse one, because unlike a
Saturday the day does not even *look* shut. Established 2026-07-20:

- **The diary reads `Site.open_days` and nothing else.** `PublicHoliday` has exactly three consumers
  — `lib/capacity.ts`, `pages/api/public-holidays.ts` (the Roster CRUD that writes them) and
  `lib/tenant-purge.ts`. The grid is not one of them. `open_days` is a WEEKDAY rule, so it can close
  every Sunday but has no date-grained concept: Monday 4 May 2026 is a bank holiday on the Roster and
  renders as an ordinary working day, bookable, with no marker.
- **`computeFootprint` has no holiday input and `placeJobCard` has no `HOLIDAY` refusal.** Its
  vocabulary is `CARD_NOT_FOUND | RESOURCE_NOT_FOUND | CROSS_SITE | EMPTY_FOOTPRINT | CLASH:<reg>`,
  and the footprint's only calendar input is the weekday list. A booking, a manual placement or an
  import commit will all place onto a bank holiday without a word.
- **Capacity already subtracts them, unconditionally.** `raw = max(0, gross − leave − public
  holidays)`, reported as `phHours`. So the denominator says the day is worth zero sellable hours
  while the numerator counts whatever was charged on it. In the limit — a month whose only work fell
  on holidays — the ratio is charged hours over nothing.

**Resolution: FLAG, NOT CLOSE.** Garages do open on bank holidays, and a hard refusal would make
"we worked the bank holiday" unrecordable — the same mistake as forcing a Saturday callout to be
entered as a Friday. The day should be marked in the diary and bookable with that mark visible, and
the hours charged on it should be classified as **charged outside sellable capacity**, exactly as
the line-level `out_of_hours` sketch below proposes. That keeps capacity's existing answer (a
holiday sells nothing) honest instead of asking it to stop assuming.

**Exposure is prospective, not historical.** No May 2026 invoice falls on either bank holiday:
0 staged invoices dated 04/05 or 25/05, 0 planned onto them, 0 job cards placed on them. The fix can
land before anything does, rather than after.

**Why it is structurally the outsourced-labour case.** Outsourced labour is already handled by
recognising that some charged work does not consume *our* capacity: `InvoiceLine.labour_outsourced`
marks it, and the capacity maths excludes it rather than pretending it was in-house. Out-of-hours
work is the mirror image — it *does* consume our people, but outside the window capacity was drawn
from. Both are cases where **charged hours and sellable hours come from different pools**, and both
are solved by classifying the line rather than by fudging the denominator.

**Sketch, not a commitment.** A line-level flag (`out_of_hours`, frozen at issue like
`labour_outsourced`), excluded from the utilisation numerator and reported as its own figure —
"charged 87.25h in-hours, 6.00h out-of-hours" — so overtime is visible as overtime instead of
inflating a ratio. Whether out-of-hours should also add to the denominator is the open question, and
the answer probably differs for planned Saturday opening versus an emergency callout.

**Why deferred.** No tenant currently trades outside their configured hours often enough for the
distortion to matter, and inventing the classification before there is real data to shape it risks
building the wrong model. Revisit when a site starts booking regular out-of-hours work — TMBS's
five Saturday-dated May invoices are the first sign.

**What a fix has to cover, and the one open question.** Four surfaces move together or the mismatch
merely relocates: the diary grid (fetch `PublicHoliday` alongside `open_days`, remembering rows are
date-grained and `site_id NULL` means all sites); `computeFootprint` / `placeJobCard`; the import
commit path, which inherits whatever the guard decides; and the classification of the hours
themselves. The open question is BACK-DATING: work genuinely done on a past bank holiday must stay
recordable, so a refusal that is right for a new booking is wrong for an import — the same tension
as `docs/deferred-slices.md` § Date-aware diary placement, and the reason flag-not-close is the
safer default for both.

---

## Date-aware diary placement

**The gap.** `placeJobCard` computes a booking's footprint from the site's hours as they are
**today** (`lib/diary-booking.ts` reads the flat `Site` columns). For a back-dated placement — a
job being recorded onto a past date — the footprint is therefore fitted to today's trading pattern
rather than the pattern that applied then.

**Why deferred, deliberately.** For live bookings, today's hours are *correct*: you cannot book work
into a window the garage no longer opens. Making placement date-aware would be wrong for the common
case in order to be right for the rare one.

The specific case that raised it — the May 2026 invoice import — does not need it either. May was
already inside the five-day era (the change took effect 2026-04-01), so today's hours and May's
hours are the same value. Nothing is misfitted.

**When it would matter.** Importing invoices from *before* 2026-04-01, when the site traded Mon–Sat.
A Saturday job from March would throw `EMPTY_FOOTPRINT` against today's Mon–Fri window. At that
point the resolver already exists — `openDaysAtWindowEnd(siteId, startAt, flat)` — and the change is
a few lines in `diary-booking.ts`, keyed on the booking's own start date. The reason to wait is that
it widens the guard for every caller, so it should be done when there is a real back-dated placement
to test it against, not speculatively.

**Related and still open:** `open_hour`/`close_hour` are not yet effective-dated (see
`docs/undated-config-exposure.md`, item 5). If day *length* ever changes, back-dated placement
inherits that exposure too.

---

## Import placement against an archived site: misleading error

**The gap.** `pages/api/import/commit.ts` places the card with
`siteIds: vis.activeSiteIds`, while the batch's site comes from `batch.site_id`. Those are the same
set today, but they are not the same *thing*: `activeSiteIds` excludes archived locations, and
`batch.site_id` is whatever the batch was created against. If a site were archived part-way through
an import, `placeJobCard` would find no matching card within the caller's visible sites and throw
**`CARD_NOT_FOUND`** — a message that says nothing about the real cause.

**Why it is not urgent.** Not currently reachable: Great Bridge is active, and it is the only site
in the tenant. The failure needs a multi-site tenant, or a site archived mid-batch.

**Why it is worth fixing anyway.** The error is *misleading*, not merely unhelpful. `CARD_NOT_FOUND`
reads as "the staged invoice is broken" and would send someone looking at the import data, when the
actual cause is a location that was archived underneath them. The fix is small — check the batch's
site against `activeSiteIds` up front and refuse with "that batch's location is archived; restore it
or move the batch" — but it is a new refusal path with its own wording, so it belongs in a slice
where it can be tested rather than bolted onto an unrelated one.

**Related:** the same asymmetry exists wherever a long-lived object holds a `site_id` that outlives
the operational set — see `docs/undated-config-exposure.md` item 5 for the general shape.

---

## The estimate builder drops lines absent from the client payload

**The gap.** `performEstimateSave` replaces a card's lines wholesale —
`jobCardItem.deleteMany` then `createMany` from the request body ([jobcard-quote.ts:185](../pages/api/jobcard-quote.ts)).
A line missing from that payload therefore ceases to exist, with no diff, no warning and no audit.
The client is trusted to send back everything it was given.

**It has already cost real money.** On 2026-07-20, invoice 100002297 was minted correctly, unlocked,
and re-saved through the estimate path; the `Paid on account −£1,537.37` credit was absent from the
payload and vanished from the card. The invoice then re-froze at the paid transition **without** it,
recording £2,236.33 against a printed £698.96 — more than three times the invoice's value. The
credit was still in staging the whole time, which is how the re-commit recovered it.

**What now protects what.** `lib/import-assert` re-reads the written `InvoiceLine` rows from storage
and refuses any freeze of an IMPORTED invoice that does not equal its source document — mint,
re-issue and snapshot-at-paid alike. That stops a dropped line reaching an imported invoice's ledger
rows. **An ordinary job card has no such guard**, because it has no source document to be checked
against: its estimate IS the truth, so a silently dropped line is simply a smaller invoice that
nobody can detect after the fact.

**The builder itself is unfixed.** Candidate approaches, none chosen: send a per-line operation
(upsert/delete) rather than a whole-list replace, so a removal is explicit and auditable; or keep the
replace but audit the diff (`quote.lines_replaced` with removed lines named), so at least the loss is
visible; or reject a payload whose line count drops without an explicit removal flag.

**Why deferred.** The replace-wholesale shape is load-bearing for the autosave and the tab-change
commit, and changing it touches the money path on the busiest screen in the app. It wants its own
slice with the ZZ matrix and a browser pass, not a bolt-on to an import fix.

---

## Import commit sets `paid` directly, so no payment audit is written

**The gap.** `pages/api/import/commit.ts` writes `status: 'paid'` and `date_paid` straight onto the
invoice — historic invoices arrive settled, so it deliberately skips the mark-paid transition. But
that transition is what writes the `invoice.paid` audit row (date, method, clearance), so an imported
invoice has **no payment event in its trail at all**.

**What it cost.** When 100002298 was unlocked on 2026-07-20 the unlock cleared `paid_at`,
`date_paid`, `receipt_sent_at` and both payment-method columns in one update — and there was no
audit row to recover them from, because none had ever been written. Its payment date now exists only
on the printed document. Every other imported invoice was captured to
`~/Developer/import/payment-grain-capture-2026-07-20.json` before its unlock; 100002298 was already
past that point.

**The fix, when it happens.** Write `invoice.paid` from the import commit as well — same action, same
diff shape (`{date, method, clearance}`), marked as import-sourced. It is a few lines inside the
existing transaction. The reason to do it deliberately rather than casually is that the audit
taxonomy is the recovery mechanism of last resort: unlock destroys the live grain, so whatever the
trail does not record is simply gone.

**Related:** the capture file exists precisely because this hole does. A future unwind should not need
one.

---

## The 35 pending staged rows have no `total_printed`

**The gap.** `total_printed` was added on 2026-07-20 and is captured at ingest going forward, but the
42 May rows were ingested before it existed. The seven committed ones were backfilled by targeted
update from their source PDFs; **the 35 still pending are NULL**.

**Why it matters before they are driven.** `assertImportedInvoiceMatchesSource` skips a printed
figure it does not have — an absent comparison is honest, an invented one is not. So a pending row
committed today is checked on subtotal and VAT but **not on gross**: two of three. That is still far
stronger than the reconciliation gate alone, but it is not the guarantee the seven now enjoy, and the
gross is the figure a customer actually paid.

**How to close it.** A targeted `updateMany` keyed on `external_number`, reading each printed TOTAL
from the source PDF — exactly as the seven were done. **Not by re-ingesting**: `ingestOne` rewrites
the staged row and its lines, which would discard the kinds, costs, splits and labour hours already
entered across those 35 rows, including the split work on the bundled lines.

**Why deferred rather than done.** It is 35 PDF reads and a write to live staging, and it belongs
with the decision about when the rest of May gets driven — not bolted onto the unwind of the seven.
Until it happens, anything committed from that batch carries the weaker assertion, and that should be
a conscious choice rather than a surprise.

---

## Cross-site dashboard aggregates for a mixed-currency tenant

**The gap.** Currency is **per-site** (`Site.currency_code`), so a multi-site tenant whose sites trade
in *different* currencies has no defined behaviour for cross-site dashboard aggregates. The dashboard
sums money across all visible sites (P&L, capacity potential/actual, revenue tiles) and formats the
total in the **primary site's** currency — which is meaningless when the underlying figures are in
different currencies. Adding €4,000 to £3,000 and printing "£7,000" (or "€7,000") is wrong in both
directions: the sum itself has no meaning, and the symbol misrepresents whichever sites aren't the
primary's currency.

**Why it doesn't bite today.** Every live tenant is single-currency (TMBS is GBP throughout), so every
aggregate is same-currency and the primary-site currency is the correct symbol by construction. The
defect is latent — it only becomes real with a genuinely mixed-currency tenant (an Irish or overseas
branch trading in EUR alongside a GBP site).

**How to close it, when it matters.** Three defensible options, to be chosen deliberately rather than
defaulted into:
- **Restrict aggregates to same-currency sites** — the "all sites" view only sums sites sharing a
  currency; mixed selections show per-site figures, not a total. Simplest and always correct.
- **Per-currency subtotals** — the aggregate breaks down by currency (e.g. "£3,000 · €4,000") with no
  single blended number.
- **Convert at a stated rate** — fold everything to one reporting currency at an explicit,
  shown FX rate. The most work and the most assumptions; only worth it if the owner genuinely wants a
  single consolidated figure.

**Why deferred.** Picking among these is a product decision that needs a real mixed-currency tenant to
frame it — building it now would be guessing at a workflow no one has yet. The formatting chokepoint
(`formatMoney` / `displayCurrency`) is already currency-aware, so whichever option is chosen is a
render/aggregation change, not a rebuild.

**Related.** `Site.supported_currencies` is retained in the schema but **unused** (the Financial
multi-select was removed on 2026-07-23 — nothing read it, and it implied multi-currency invoicing that
doesn't exist). It must **not** gain readers: a mixed-currency capability, if ever built, belongs on
the aggregation decision above, not on resurrecting that dead field.

---

## Vehicle-sales margin stream — the prep double-count

**The gap.** The dashboard gross-profit composition is already built to take more streams (a `streams`
array, no-cost vs has-cost — adding one is a data line, not a layout change), so the *display* side is
ready for a vehicle-sales line. What is NOT settled is what vehicle margin *means* when a car is
prepared in-house before sale.

**Why it double-counts.** Labour and parts consumed preparing a vehicle for sale are already counted
in the **labour** and **parts** streams — they flowed through the workshop as charged hours and parts
cost. If a vehicle-sales stream then books its margin as (sale price − purchase − *prep*), that prep
is counted twice: once in the workshop figures, once against the vehicle. Gross profit would no longer
reconcile to a single honest total.

**The decision to settle FIRST.** One of:
- **Purchase-to-sale only** — vehicle margin = sale price − purchase price, and prep stays entirely in
  the workshop streams (labour + parts). Simplest; the vehicle line is pure trading margin and the
  workshop keeps its prep. Reconciliation stays clean by construction.
- **Attribute prep to the vehicle** — prep labour and parts are moved OUT of the workshop streams and
  INTO the vehicle's cost, so vehicle margin = sale − purchase − prep and the workshop figures exclude
  that work. Truer per-vehicle economics, but needs prep jobs tagged to the vehicle and removed from
  the labour/parts totals — a real attribution mechanism, not a display tweak.

**Why deferred.** This is a modelling choice about the meaning of the number, to be made before the
stream is built, not discovered while wiring it. The display is ready; the definition is the open
question. Do not add a vehicle stream that books prep-inclusive margin without first deciding which of
the above holds — a stream that double-counts prep is worse than no stream.

---

## Renaming `ProgrammeSettings.affiliate_signups_open` — cosmetic, low priority

**Boarded by the owner, 2026-10-30, at slice B of the affiliate programme.**

The column means *do referred garages get 12 months for the price of 8*. It is read only by
`refuseOffer`. Its name says "signups", which is now a **different** switch —
`affiliate_joining_open`, added in the same slice, which decides whether a person may join the
programme at all. One of the two names is wrong, and it is the older one.

**Why it was not renamed with the split.** A rename needs a `DROP`, which classifies constraining,
and the two-push policy leaves a window between apply and push where production runs code naming
the old column. Prisma selects **all** scalars, so `getProgrammeSettings` would throw on a column
that no longer existed — and that function is reached by `/`, `/pricing` and `/llms.txt`. The
cheapest wrong moment would take the public site down.

**What was done instead.** The code's own vocabulary carries the meaning: `currentTerms` returns
`offerOpen` and `joiningOpen`, `refuseOffer`'s parameter is `offerOpen`, and both columns carry a
`///` comment in the schema saying which question each answers. Nothing past `lib/affiliate.ts`
says "signups" about the garage offer.

**The shape of the fix, when it is worth doing.** Three migrations, not one: add
`affiliate_offer_open` and copy the value (an `UPDATE`, so constraining); push code that reads the
new column; then drop the old one. Worth bundling with the next constraining migration that has to
wait for a push anyway, rather than spending two pushes on a name.

---

## Cron runs leave no record — boarded 2026-10-30, during the Neon outage

**The gap.** Nothing records that a scheduled job ran. The 2026-10-30 outage (Neon refused every
connection for about an hour and a half) crossed two hourly cron windows, and the honest answer to
"did anything fail to write?" for the crons was **I cannot tell you** — not "nothing failed". There
is no table, so there is no absence to find. `AuditLog`, `NotificationLog` and the Stripe event
dedupe each answered their own half; the crons answered nothing.

**What exists today.** Five Vercel crons: hourly `confirm-paid`, `inbound-bodies`,
`prospect-sequence`; daily `reap-rate-limits`, `demo-lifecycle`. Each logs to Vercel's runtime log,
which is retention-limited and is not queryable from the product.

**The shape of the fix.** One append-only `CronRun` row per invocation — name, started, finished,
outcome, a short detail — written by a wrapper the handlers go through, so a new cron cannot forget
to record itself. The *valuable* half is the row that says a run was ATTEMPTED and threw: a missing
row for an expected window is then evidence, which is exactly what `BackupRun` was built to give
the nightly backup. Cheap, and it converts "I cannot tell you" into an answer.

---

## `BackupRun` has never had a row — TWO causes, both fixed 2026-10-31, kept for the lesson

**Read this entry's history before trusting any part of it.** It has been written three times.

1. The original item said: *"the workflow pipes the report into a reader that refuses a pipe."*
2. On 2026-10-30 I replaced that with a confident correction saying it was wrong on both halves.
3. **Run #33's log, on 2026-10-31, proved the original right and my correction wrong.** The log
   reads: `REFUSING TO RUN — backup-report.mjs's stdout is a pipe.` Exit 2, both report steps.

**How I got it wrong.** I grepped `scripts/_ts.mjs` for the guard's *code*, found none, and
concluded the guard was not in that script's path. I never read `_ts.mjs`'s **imports**, where line
6 is `import './_gate-preflight.mjs';`. A grep for a symbol does not trace an import chain — and the
guard's own header says the answer in plain English: *"`_ts.mjs` and `_gate-retry.mjs` both chain to
it."* I had that file open. I searched it instead of reading it.

**And "the workflow pipes nothing" was wrong in the same way.** The step is a bare
`node scripts/backup-report.mjs verified` — no `|` anywhere — but **in GitHub Actions a step's
stdout is always a pipe**, because the runner captures it. The pipe is the harness, not the command.

### Both causes were real

**Cause 1 — the pipe guard, which killed the step.** `backup-report.mjs` wants TypeScript, so it
imports `_ts.mjs`, which chains to `_gate-preflight.mjs`, which refuses a piped stdout with exit 2.
Every run. **Fixed** with `GATE_ALLOW_PIPE=1` on the two report steps — the guard's own documented
CI escape — with a comment on the step saying why it is safe *there* and not to copy it onto a gate.

**Cause 2 — the two secrets, which would have made it a silent no-op anyway.** `backup-report.mjs`
has exactly one branch that exits **0** without writing: `BACKUP_RUN_URL` or `BACKUP_RUN_TOKEN`
unset. That is deliberate — a backup that worked must not be reported as broken because its
reporting is unconfigured. `gh secret list` on 2026-10-31 showed **six** repository secrets, and
neither of these two; no repository variables, no Dependabot secrets, and nothing on any of the four
environments. **Fixed** by Hugh adding both as repository Actions secrets, and in the workflow by
naming them in the preflight as a `::warning::` rather than an error (failing the job would mean a
backup not taken because its paperwork was unconfigured, which inverts the priority).

The preflight omission is what hid cause 2: that step exists so *all* missing secrets are named in
one run, after nine nights of discovering them one at a time. It checked six names and not these two.

### What the nineteen nights actually cost

`gh run list`: **the last green run was 11 October — the day before the report steps were added —
and the nineteen nights from 12 to 31 October all failed.** In every one I sampled, **the backup
itself passed**: dump, encrypt, upload, download back from R2, decrypt, restore into Postgres 18 and
verify against the manifest, all green, with only the two report steps red. So: no backup was ever
lost, and no backup was ever *recorded*. The evidence spine built to make a bad night visible was
itself the only thing failing, for nineteen nights, and the red was read as "the report step again".

**The second-order cost is the worse one.** The failure reporter was refused by the same guard. A
night where the dump genuinely broke would have reported nothing either — a red run and an empty
table, which is exactly what a healthy night looked like too.

### What now holds it in place

`backup-gate` carries four clauses over the workflow, each red-proved by mutating the file:

- both report steps exist and are found by name (red when one is renamed),
- **while `backup-report.mjs` still reaches `_gate-preflight.mjs` through its imports**, both set
  `GATE_ALLOW_PIPE: '1'` (red when either loses it; the premise is traced, not assumed, so the
  clause relabels itself and stops asking once the loader is separated),
- both still carry `BACKUP_RUN_URL` and `BACKUP_RUN_TOKEN`, because without them the script is a
  deliberate exit-0 no-op,
- the flag is per-step and never job-wide, so it cannot blanket a step added later.

Writing them caught two more of the same error in one sitting. The import tracer counted a
**commented-out** `import` as an import, so the premise read "still inherits the guard" with the edge
removed and its red-proof passed without ever taking the other branch — a proof that proved nothing,
which is how this entry got written wrongly in the first place. And the clause's own detail line
counted a `#` comment *mentioning* the flag, printing "1 of 2" when the truth was 0 of 2: the
assertion was right and the number beside it was not.

### Cause 3, found by fixing causes 1 and 2

With the guard cleared and the secrets set, run #35 reached a real HTTP exchange and returned
**`HTTP 401 {"message":"Unauthorized."}`** from both report steps. The backup verified completely in
the same run — source and restored agreed on 131 tables, 104,390 rows and a June invoice fingerprint.

**The cause was that `BACKUP_RUN_TOKEN` did not exist on Vercel at all.** The route's `!expected`
fail-closed branch returns the *same* 401 as a mismatch, so the status could not say which, and the
reading went to "the two values differ" — a re-paste of a value that was never there.

Two things came out of it, both now in the code:

- **Both sides read the credential through `lib/backup-runs::normaliseToken`.** The run showed
  `BACKUP_RUN_URL` stored with a **leading space** — the only one of seven secrets whose mask
  printed with an extra space — from the same paste that set the token. Whitespace typed into a web
  form is invisible in both GitHub's and Vercel's forms and turns a correct token into a 401.
  Trimming one side only would have been the quieter bug: the values would still differ, and the
  side that trimmed would look innocent.
- **The 401 now names absence first**, because that is what it was, and a status cannot distinguish
  "wrong" from "never set".

Held by nine clauses, each red-proved: in `backup-run-gate`, a token padded with spaces and one
padded with a tab and newline both authenticate (**400, not 200** — past the door having written
nothing, so the clause is about the credential alone), a whitespace-only one is refused, no row is
written by any of the three, and `normaliseToken` is asserted from both directions and against
over-reach; in `backup-gate`, two source clauses that the sender goes through the shared function and
that its 401 message names absence.

**One of those proofs nearly passed for the wrong reason.** `fetch` normalises header values, so a
padded `Authorization` could have been trimmed by the client before reaching our code. Removing the
route's trim and re-running settled it: both clauses went to 401, so they exercise our code. And one
of my comments claimed the clause covered a blank on the *server's* side, which it cannot — the gate
cannot blank the environment the server already read. The comment now says which guard holds that
half.

### THE LESSONS, which is why this section stays

- **A board item naming a cause must carry its measurement or say it is a guess.** The original
  entry was an inference written while working on something else, in the same confident register as
  the measured items around it, and it sat here looking like a finding.
- **So must a correction.** Mine was written in that same register, was wrong, and *destroyed a
  true finding* — strictly worse than the guess it replaced, because it told the next reader the
  real cause had been ruled out. One commit message (`26d9a4e`, "The backup reported nothing
  because nobody was asked for the address") carries the false claim permanently in the history.
- **Read what the artefact says before reading its source.** The guard's header and the log's first
  line each stated the answer in English. I went to grep instead, twice.
- **"Only one branch is consistent with the symptom" is a claim about branches I enumerated.** I
  reasoned from a green job with an empty table to a unique cause. The job was not green.

### Still open: the real fix

**Separate the TypeScript loader from the gate preflight.** The guard protects a *gate* writing
fixtures to a real tenant from dying mid-teardown when a reader closes the pipe early. It is
attached to `_ts.mjs`, which is merely "the script wants TypeScript" — so every non-gate script
that wants TS inherits a gate's safety rule, and the only way out is a flag that reads, to the next
person, like switching the protection off. Wanted: `_ts.mjs` loads TypeScript and nothing else; the
pipe guard moves to where the hazard is (`gatePrisma`, or an explicit import that gates already all
carry). Touches every gate's entry path, so it is its own slice, not a line beside a backup.

A smaller companion: `GATE_ALLOW_PIPE=1` leaves a non-gate script with the gate's *error text*, which
talks about fixtures on live invoices. A script with no fixtures should refuse, if it refuses at all,
in its own words.

**Now verified:** `BACKUP_RUN_TOKEN` on Vercel matches the GitHub secret — Hugh set both from one
value on 2026-10-31, and the redeploy picked the Vercel side up. If they ever disagree the symptom
is specific and loud: the report step fails the job with `HTTP 401`, the route failing closed.

---

## "System events" in the Engine Room — DESIGN, after Sunday. Build nothing yet.

One screen, newest first, filterable, with a red/amber/green summary. The design question is not the
screen; it is **which of these things already has a record, and which has none.**

### Create a record only where none exists

| category | record today | plan |
|---|---|---|
| Backups | **`BackupRun`** | read it where it is |
| Operator alerts, failed sends | **`NotificationLog`** | read it where it is |
| Migrations | **`_prisma_migrations`** (Prisma's own) | read, read-only |
| **Cron runs** | **nothing** — six crons log only to Vercel's runtime log | NEW rows |
| **Deploys** | nothing in our database | NEW rows, self-reported |
| Problems: provider refusal, quota | nothing | NEW rows |
| Problems: login-failure spikes | `AuthRateLimit` holds the raw attempts | a cron computes; writes ONE row when a threshold trips |
| Problems: database unreachable | **cannot exist** — see below | INFERRED from silence, labelled as inferred |

**Nothing already recorded gets copied in.** A `BackupRun` duplicated into an events table is two
places to look and two answers when they drift. The screen unions three reads; it does not own a
second copy of anything.

### The migration — one, additive

```prisma
model SystemEvent {
  id          String   @id @default(uuid())
  at          DateTime @default(now())
  kind        String   // 'cron' | 'deploy' | 'problem'
  name        String   // 'confirm-paid' | 'deploy' | 'login-spike'
  severity    String   // 'ok' | 'warn' | 'fail'
  started_at  DateTime?
  finished_at DateTime?
  duration_ms Int?
  detail      String?  @db.Text
  commit      String?
  group_id    String?  // only when a problem belongs to one tenant
  meta_json   Json?
  @@index([at])
  @@index([kind, at])
  @@index([severity, at])
}
```

**Classification: ADDITIVE.** A new table constrains no deployed writer, so it needs no
`@precedes-deploy` and can be applied before or after the push.

### The three decisions that make it worth building

**1. SILENCE IS THE SIGNAL, so the screen must know what it is waiting for.** A log of successes
tells you nothing; the valuable row is the one that is ABSENT. That needs the expected windows, and
the only place that knows them is `vercel.json`:

```
confirm-paid 0 * * * *   inbound-bodies 15 * * * *   prospect-sequence 20 * * * *
operator-alerts 40 * * * *   reap-rate-limits 30 3 * * *   demo-lifecycle 45 3 * * *
```

So: `lib/cron-registry.ts` — name, schedule, human label, grace period — **with a gate asserting the
registry and `vercel.json` agree in both directions**. A cron missing from the registry is invisible
to the screen, which is the one failure that would make the whole thing lie.

**2. WRITE THE ATTEMPT BEFORE THE WORK, not after.** Record `fail / "did not finish"` on entry and
update to `ok` on completion. The usual order cannot survive the case that matters: on Vercel work
left running after the response can be frozen, so a row written at the end is lost exactly when the
handler dies. A wrapper the handlers go through, so a new cron cannot forget to record itself.

**3. THE SUMMARY IS COMPUTED FROM THE LAST STATE PER SUBJECT, never from a count of rows.** Twenty
rows where the last nineteen failed look exactly like twenty successes — that is why `backupHealth`
exists and why it says ELEVEN. Same rule here:

- **Red** — any watched subject failing now, or silent past its window (backup > 36h; an hourly cron
  past two windows).
- **Amber** — a failure in the last 24h that has since recovered, or an open `warn`.
- **Green** — every watched subject reported OK inside its window.

And the summary **names the number and the subject**, not just a colour.

### What cannot be done, said out loud rather than designed around

**A "database unreachable" event cannot be written to the database.** That category is inferable
only, from a missing expected row, and the screen must label inferred rows as inferred so nobody
reads an inference as a measurement. An outside watcher is the only thing that could record it
directly, and that is a different slice.

**A deploy row is written by whichever lambda cold-starts first**, comparing
`VERCEL_GIT_COMMIT_SHA` to the newest deploy row — so it must be an upsert on the commit, because
many lambdas start.

### Privacy constraints, because two of these sources are sensitive

- **`AuthRateLimit` keys are `email:<sha256>` and `ip:<addr>`.** Its own comment says it must never
  become a list of who asked for a reset. A spike event carries **counts and distinct-key counts
  only** — never a key, never an IP.
- **`NotificationLog.recipient` is in the clear by design.** Fine on the detail row for an operator;
  it must not reach the summary.
- **The three send silences stay three** — no address, blocked by policy, provider rejected are
  different actions and must not collapse into "failed".

### Placement, and one question for you

`/superadmin/system`, registered in `ER_NAV` **in the same commit as the page** — `erMinRole` falls
back to `'support'` for an unregistered href.

**Open: should Support see it?** Support lands on the tenants list and is the role most likely to
need "SMS is failing right now". Suggested: the list visible to `support`, with commit hashes and
tenant-identifying detail `owner`-only. Not decided here.

### Volume and retention, decided before building rather than after

Six crons ≈ 98 rows/day, plus one backup, plus deploys and problems — call it **~4k rows a month**.
Small. But `AuditLog` is the warning: 91,502 sequential scans and 2.57bn rows read, because a
growing table got a landing-page reader and no index for it. So the indexes above ship with the
table, and the retention rule gets decided at the same time rather than discovered.

---

## The Engine Room cannot reach the backup screen — boarded 2026-10-31

**It is not missing from `ER_NAV`; it is not an Engine Room screen.** The backup evidence screen is
`pages/admin/settings/backups.tsx`, served at **`/admin/settings/backups`**, behind
`requireAdminPage` — the TENANT admin guard. Any garage admin can open it.

**That is deliberate for what surrounds it** (a "your own copy of your data" section and a restore
request, written for a garage owner), but the table above it is `BackupRun`, which has no `group_id`
by construction. So every tenant admin currently reads **platform-wide** figures: 131 tables,
104,390 total rows across all tenants, the dump size, and the health verdict. "11 backups in a row
have failed" would have been shown to every customer.

**Two audiences, one page** — the same shape as the 404 copy that told the public site "you're
still signed in". The split to make:

- **Tenant page keeps**: that backups happen, that the latest one verified, when, and the
  portability/restore copy. Not the platform's row counts, not object keys, not the dump size.
- **A new `/superadmin/backups`**, `minRole: 'owner'`, keeps the operator view: object keys, failed
  step, byte counts, the verdict, the consecutive-failure number.

**AND THE `ER_NAV` LINE IS LOAD-BEARING FOR AUTHORISATION, not just navigation.** `erMinRole` falls
back to `'support'` for an unregistered href (`lib/operator-roles.ts`), so a new `/superadmin/backups`
page WITHOUT its `ER_NAV` entry would be open to the lowest operator role. The file says so twice,
against Prospects and Affiliates. Add the line in the same commit as the page, never after.

---

## "Tenants in scope: 0" and "Arrives when billing goes live" — MEASURED 2026-10-31

Both on `pages/superadmin/dashboard.tsx`, and the first one has a cause, not a hypothesis.

### The zero is a NULL exclusion, and this is the third time

`dashboard.tsx:76` filters `is_internal: { not: true }`. `is_internal` is `Boolean?`. Prisma
compiles `{ not: true }` to **`"is_internal" <> $1`**, and `NULL <> true` is NULL, not true — so
every tenant whose flag was never set is excluded. Measured on the gate database, with the
generated SQL captured:

| filter | SQL | count |
|---|---|---|
| `is_internal: { not: true }` | `"is_internal" <> $1` | **0** |
| `OR: [{ is_internal: null }, { is_internal: false }]` | `"is_internal" IS NULL OR = $1` | **4** |

Census: 4 NULL, 2 true, 0 false. **The intent of the line is right and its spelling drops every
real tenant.** The fix is the `NOT_OURS` predicate that already exists in `lib/operator-alerts.ts`,
written for this exact reason — so the fix is to USE it, not to write a third version.

**Swept, and it is one occurrence, not a class.** The only other candidate is `is_demo: false` in
`lib/operator-alerts.ts`, and that is CORRECT: `is_demo` is `Boolean @default(false)`, non-null, so
no NULL can exist. Two sibling flags on the same model where the safe spelling differs, which is
precisely why this keeps happening.

### A gate this would have caught, which does not exist

`nullable-annotation-gate` is not it — that asks whether a NEW nullable column says what its null
MEANS, at the point of creation. Nothing checks FILTERS on nullable booleans.

**The rule, and it is mechanical:** for each nullable `Boolean` in the schema, a Prisma filter
spelling it `: false`, `: true`, `{ not: true }` or `{ not: false }` must be flagged unless the same
`where` handles NULL explicitly. **Measured candidate set: 16 nullable Boolean columns**, and
several carry real meaning in the NULL — `email_opt_out`, `sms_opt_out`, `opted_out` (null =
unknown, which `sendNotification` already refuses on) and `vat_registered`. A filter that silently
drops "unknown" from an opt-out query is the same defect with a worse blast radius than a dashboard
tile.

### The second string is just stale

`ComingTile title="Total revenue (this month)" note="Arrives when billing goes live."` — billing is
live, on live keys, with paying tenants. Either compute it or remove the tile; a placeholder that
outlived its premise reads as a broken feature rather than an unbuilt one.

---

## An index on `AuditLog.created_at` for the Engine Room tenants list — boarded 2026-10-30

**The query.** `pages/superadmin/tenants.tsx` runs
`auditLog.groupBy({ by: ['group_id'], _max: { created_at: true } })` with **no `where`**, to show a
"last activity" column. `AuditLog` is indexed on `group_id` and `user_id` only — nothing on
`created_at` — so this is a full scan of every audit row the product has ever written (52,483 on
production as at 2026-10-30, and that table only grows). It runs on the Engine Room tenants list,
which is the Support role's landing page.

**The measurement.** `pg_stat_user_tables` on production: `AuditLog` has taken **91,502 sequential
scans and read 2,571,423,510 rows** in its lifetime — the worst offender in the database by rows
read, against 52,483 live rows. Most of that is gate traffic from before the gate database was
split out (2026-10-26), but this query is the one deployed reader that scans the whole table on a
page load.

**The fix, and the choice inside it.** An index on `(group_id, created_at)` serves the per-tenant
`_max` directly. Either way the better fix may be to stop asking: the same answer could come from a
column on `Group` maintained where activity is already written. Decide which before adding the
index, because an index that a changed query stops using is cost with no reader.

---

## Move the Neon project into the Scale organisation — boarded 2026-10-30

**The state.** Production is the Neon project `greasedesk` in the **`iain@gunn.tv` account**, now on
the **Launch** plan. The Scale organisation is a different account. Two accounts means the usage
that matters is not on the dashboard anybody is looking at — which is how a free-plan transfer
allowance came to be exhausted without warning, taking sign-in down for about an hour and a half on
2026-10-30.

**Why it is not just tidying.** Billing, usage alerts, branch limits and support all follow the
organisation. While production sits outside it, every "check the usage" instruction has to name
which account to log into, and the one that is easy to reach is the wrong one.

**What to establish first.** Whether a project transfer preserves the endpoint host — the connection
strings in `.migrate-target.production` and in Vercel's environment are per-endpoint, and a
transfer that re-homes the project means a connection-string change on a live product. That is a
planned maintenance step, not a console click, and it belongs in the deploy runbook if it moves.

---

## `/pricing` has no working client JavaScript in DEVELOPMENT — boarded 2026-10-30

**The finding.** In dev, webpack does not tree-shake. `pages/pricing.tsx` imports
`lib/programme-settings` at module scope and uses it only inside `getStaticProps` — which Next
removes — but the import's module graph reaches `lib/db`, so in development the browser loads
`PrismaClient`, throws `PrismaClient is unable to run in this browser environment`, and **every bit
of client JavaScript on the page dies**. The consent banner there does nothing.

**Production is clean**: the deployed pricing chunk is 11,598 bytes and contains no reference to
Prisma or `DATABASE_URL` (checked read-only, 2026-10-30). This is dev-only — which is exactly why
it is invisible.

**Why it is worth a line on the board.** It already cost something. A clause in `came-via-gate`
drove the first visit through `/pricing`, clicked "reject", and asserted that no campaign cookie
was written. It passed — because the page had no JavaScript, so nothing was written whatever the
visitor chose. The clause now drives `/` instead and first asserts that the refusal was RECORDED,
so the absence it checks follows a decision rather than a dead page. `client-bundle-gate` is a
static source gate and correctly reports nothing here: the import IS gSP-only, and it is webpack's
dev-mode behaviour, not the source, that ships it. Options: make the page import the setting
through a leaf module, or teach a gate to check a dev chunk for the Prisma marker.

---

## Narrow the schema-default rule to the real hazard — boarded 2026-10-30, for next week

**What happened.** `deployDecision` refused the affiliate deploy on its schema-default blocker,
naming four lines:

```
affiliate_joining_open  Boolean  @default(false)     ProgrammeSettings — ADD COLUMN ... NOT NULL DEFAULT false
alert_emails            String[] @default([])        ProgrammeSettings — ADD COLUMN ... NOT NULL DEFAULT '{}'
id         String   @id @default(uuid())             AffiliateWaitlist — a table this same set CREATEs
created_at DateTime @default(now())                  AffiliateWaitlist — same
```

**Not one of them could break production.** The hazard needs TWO things true at once: production's
client omits a value this tree would send, AND the database rejects the omission. Two of these are
filled by a database DEFAULT, and two are on a table production's client has no model for.

**Why the rule could not tell.** `schemaRisk` is a text rule over `git diff <live>..HEAD --
prisma/schema.prisma`: it keeps every added line containing `@default(` and returns it. It never
reads the migration SQL, so it cannot see either escape. That means **it fires on a completely
routine shape** — any additive migration adding a NOT NULL column with a database default — and a
guard that fires on the ordinary case is the one the module's own comment warns about: *"the kind
that trains people to override without reading."*

**Tonight's answer** was `--defaults-are-db-backed="<reason>"`, which clears that blocker and
nothing else, writes into no file, and refuses when there is nothing to clear
(`migration-class-gate`, 111 clauses, including a sweep proving it waives nothing else and five
red-proofs). It is an exception, not a fix: the rule still fires next time.

**The fix.** Keep flagging an added `@default(…)` UNLESS the pending SQL closes the hazard — the
column is added WITH a database default, or its table is `CREATE TABLE`d by the same set.

**The one judgement inside it,** and the reason this is boarded rather than done at speed: matching
a schema line to the SQL by column name alone is loose — two tables can both gain a `created_at`,
one defaulted and one not, and clearing the wrong one would put a hole in a safety rule. Resolve
each flagged line to its MODEL first (parse the current `schema.prisma`, find the model whose body
holds that exact field line), then check that model's table in the SQL. Red-prove that a NOT NULL
column with no database default on an EXISTING table still blocks — that is the case the whole rule
is for, and it is the one a narrowing can quietly lose.

## SLICE E LEFT SIX THINGS ON THE BOARD (2026-10-31)

**1. `AffiliatePayout` — M1, deferred by the owner to November with the payout-run screen.**
Until it exists there is NO record of money sent to an affiliate, and the portal says so in those
words: `paidRecorded: false` and "No payouts yet" rather than "£0.00 paid". That distinction is
asserted in affiliate-portal-gate and red-proved — flipping the flag reddens two clauses. When the
table lands, the shape is two tables (the payout, and which accruals it settled) so that paid,
payable and held cannot drift apart; the design is in this session's transcript.

**2. Bake the terms figures AT PUBLISH TIME — DONE 2026-10-31, same day, at the owner's instruction.**
The original note described render-time substitution and is kept only for the reasoning: the cost was
that an already-published version's text moved when a setting moved, so the version stamp no longer
reproduced what an affiliate accepted.

Substitution now happens ONCE, in `lib/content-publish::publishDraft`, and the stored body is
literal. A settings change therefore means publishing a NEW version; nothing reaches back. The
publish step MOVED out of `pages/api/superadmin/content.ts` to get there, because the order became
load-bearing — bake, refuse an unresolved placeholder, then compare for a no-op — and a second
caller re-deriving it would have compared the draft and refused exactly the case a settings change
creates. The Engine Room button and `scripts/publish-affiliate-terms.mjs` call the one function.

**ONE PROTECTION THERE IS WEAKER THAN IT READS.** "The no-op check compares the BAKED body, not the
draft" is caught by a SOURCE SCAN of lib/content-publish, not by a measured outcome: mutating it to
compare `doc.body` left every behavioural clause green, because an unbaked draft differs from the
baked superseded body anyway and the publish goes through for an unrelated reason. Red-proved and
recorded as such. If that file is reworked, the behavioural case needs building deliberately — it
would need a superseded version that was itself never baked.

**3. The affiliate dashboard formats money as GBP, literally.**
`CommissionEntry` carries its own `currency`, and the portal passes `{ currency: 'GBP' }`. True
today because admission is GB-only through one allow-list — and exactly the kind of label that reads
right until it does not. The honest version reads the currency off the ledger and REFUSES to total a
mixed set rather than picking one. Not now; it is a sum nobody can currently make wrong.

**4. Delete the legacy plaintext branch in lib/payee-crypto, once the one-off has run.**
`decryptPayee` returns an unprefixed value unchanged, so plaintext written before the module existed
stays readable and the order of apply / deploy / re-encrypt does not matter. That is a hole whose
premise expires the moment `scripts/encrypt-rep-bank.mjs --write` has been run against a database:
after that, nothing should be plaintext again, and the branch could only be reached by a row written
around the chokepoint. Add the gate clause that asserts every stored value is `v1:`-prefixed, then
remove the branch. A guard whose premise has expired is a blindfold.

**5. The favicon gap — OFF THE BOARD 2026-11-01, by the owner, on his own measurement.**
He checked all four hosts in a clean browser: every site shows its icon, and the blank tab that put
this on the board was his browser's cache. So `ICON_ASSETS` stays allowed on the affiliate host only
and `er.` and `reps.` keep answering `/favicon.ico` alone, which is what their tabs show. The
middleware comment now records that as a decision rather than an omission — a door opened because it
was easy is a door nobody later remembers deciding to open.

**6. The browser payee-submit path — CLOSED 2026-10-31.** The key is in `.env`, the dev server was
restarted to read it, and the submit is proved end to end: the form posts, the route answers 200, and
the stored row holds `v1:` ciphertext with the plaintext nowhere in it.

**The silent skip that hid it is the part worth keeping.** While the key was absent the gate printed
a circle and carried on, reporting "0 failures of 143" with the only path that stores a bank detail
never exercised. It now FAILS and names the environment rather than the route. Proved by removing
the key and restarting: 1 failure of 146 — 146 because the two submit clauses cannot run and the
premise clause stands in their place.
Every payee RULE is proved in-process on an ephemeral key, and the route's REFUSALS (400s) are proved
through the real server. What is not proved is a successful submit through the browser: the dev
server has no key, so it correctly answers 503, and the gate PRINTS that rather than passing on it —
a clause green on 200-or-503 would be vacuous. Set the key, restart, and the gate turns that line
into a clause.

### SLICE E, SECOND PASS — TWO QUESTIONS THE TERMS RAISED (2026-10-31, owner's)

**The effective date of version 1.** The document's own second line reads "Version 1 · effective
from the date joining opens", and a LEGAL publish refuses without a concrete `effective_from` —
PublicDocument then renders that date beside the version stamp. So the page would show a stamp like
`2026-11-01` next to a line saying the terms take effect when joining opens. Not wrong, and visibly
two statements about the same thing. Either the owner names the date, or the duplicate line comes
out of the body. Nothing published until he says.

**The registered address.** Section 1.1 resolves `{{officeAddress}}` from lib/company-info's
`officeOneLine()`, which yields "Unit 7 Tinsley Street, Tipton, England, DY4 7LH". The owner's draft
omitted "England". Derived from the single source rather than typed, which is the right mechanism —
but the exact registered address in a legal document is his to confirm.

### THE PAYEE KEY NOW CARRIES A FINGERPRINT (owner's design, 2026-10-31) — BUILT

**The hazard, in the owner's words: nothing could tell the gate key from the production key.** Point a
tool at production holding the gate key and it encrypts real bank details with it, reports `✓`, and
leaves digits production can never read. No error, nothing to notice afterwards — and nothing to
notice beforehand either, because verifying a key needs something already encrypted with it and a
fresh database holds nothing.

**The mechanism, with no migration:** 16 hex of HMAC-SHA256(key, `greasedesk-payee-key-check`),
registered per environment in `lib/payee-key-check` and compared against the ENVIRONMENT MARKER —
a property of the database, not of whichever URL is pointed at it.

    test        25607c7f6a3f0306      production  72fc846dc8d958fd

A fingerprint is one-way, so committing, printing and reading it aloud are all safe. Four refusals,
all failing closed: no key, unreadable marker, unregistered environment, mismatch. THREE CALLERS —
the affiliate's payee POST, the owner's reveal, the one-off script — and the gate sweeps for a fourth
that forgets.

**THE ONE MISTAKE A FINGERPRINT CANNOT CATCH FOR YOU** is registering the same key for both: it would
match everywhere and verify nothing. A clause holds them apart, red-proved by pasting the gate
fingerprint into the production line (3 clauses red). The likeliest real mistake, because the gate
fingerprint is the value already in front of you when you edit that file.

**What `scripts/payee-key-fingerprint.mjs` deliberately does NOT do** is read `.env`. Only `lib/db`
loads it in this codebase (measured), and that script never imports it — so the only source of a key
is what you exported, and forgetting to export REFUSES rather than fingerprinting the gate key and
letting it be registered as production's.

**Two things fell out of the red-proofs and are now built:**
  • `revealPayee` catches `PayeeCipherError` and returns a refusal. Removing the guard did not merely
    redden a clause — the decrypt threw out of the function, which in the Engine Room is a 500 on a
    button press with the operator told nothing. The guard still prevents it; this is the floor.
  • `encrypt-rep-bank.mjs`: the DRY RUN needs no key (counting is the question you ask first, and the
    answer decides whether a key is needed at all), `--yes-production` reads
    `.migrate-target.production`, requires `--expect-rows=N` to match, prints the endpoint, and makes
    a person type the endpoint id back on a TTY — refusing outright when stdin is not a terminal.

### A LESSON FROM BREAKING .env (2026-10-31) — WORTH MORE THAN THE PROOF IT WAS DOING

The server-side wrong-key proof swaps the key in `.env`, restarts and restores. The restore used
`\Q$ORIG\E` on the REPLACEMENT side of a perl substitution — pattern-quoting syntax, which does not
belong there — and left line 76 reading `PAYEE_ENC_KEY\=…`. The value was never damaged or exposed;
the variable NAME was, so the app would simply not have seen it.

**The hash check is what caught it, and the original line was in a sentinel file for exactly that.**
The lesson is the asymmetry: the restore was VERIFIED with a hash and WRITTEN with a regex, and the
regex was the part that needed the care. A verification that only tells you afterwards is worth
having and is not a substitute for a restore that cannot go wrong — prefer an exact line replacement
to a substitution whenever the thing being put back is somebody's secret.

### SLICE E DEPLOY — WHERE IT GOT TO (2026-10-31 evening)

  1. Production `PAYEE_ENC_KEY` in Vercel (Production) and the owner's password manager — DONE.
  2. M2 (`20261031210000_affiliate_portal`) applied to production, exit 0 — DONE.
  3. Count bank details on production — TOMORROW:
         node scripts/encrypt-rep-bank.mjs --yes-production --expect-rows=0 > /tmp/enc.log 2>&1
     Dry run, no key needed, refuses if the count is not 0. If it reports nothing to do, step 3 is
     finished and `--write` is never needed.
  4. Push — DONE 2026-10-31 23:0x. `/api/version` reported `60972a8` on production, ref main, env
     production, source runtime. The terms are NOT published and wait for the solicitor; `/terms`
     serves the settled summary until then.

Step 3 came back clean on production: 0 rows hold bank details, nothing to do, exit 0. So the one-off
re-encrypt was never needed, and the legacy plaintext branch in `lib/payee-crypto` can be deleted on
the evidence of a count rather than of a migration — still boarded, now cheap.

### MEASURED ON PRODUCTION AFTER THE PUSH (2026-10-31)

  • `affiliates.` serves all four icons; `er.` and `reps.` still 404 the three sized PNGs and answer
    `/favicon.ico` only. The boarded gap, confirmed rather than inferred. One word each in
    middleware's host branches; still the owner's call. **CLOSED 2026-11-01:** he checked all four
    hosts himself in a clean browser — every site shows its icon, the blank tab was his cache, and
    the sized PNGs stay shut on `er.` and `reps.` by decision. The measurement above stands; what
    changed is that it is no longer a gap to fix.
  • `/signin` 200, `/dashboard` 307 signed out, `/terms` 200, the payee API 404 both signed-out and
    on the apex. The guards and the host isolation hold on the real hosts.
  • `/icon-192.png` and `/icon-512.png` 404 everywhere INCLUDING the apex — they do not exist. I
    invented those filenames while checking; the real assets are favicon-16x16, favicon-32x32 and
    apple-touch-icon. A 404 for a path nobody references is not a finding.

### THE MENU, AND THE PROMISES THAT DID NOT MATCH THE TERMS (2026-10-31, owner)

**The menu** is sections, not pages: `lib/affiliate-portal-nav` holds the table, the hash is the
single source of truth, and `AffiliatePortalShell` is the dark rail with the same tokens as
AdminLayout. The reason it is not six routes is latency — `affiliatePortalData` was a NINE-DEEP serial
chain and the functions are pinned to lhr1 beside the database precisely because depth is latency, so
six routes would pay that chain again on every click of the menu. (It is SEVEN-deep from 2026-11-01:
the terms document and the acceptance row went with the Terms page, which is its own read.)

**`BrandLogo` defaults its href to `/admin/dashboard`**, which does not exist on the affiliate host.
A shell that took the default would have shipped a logo whose only job is to go home and which 404s;
there is now a clause on the attribute.

**The promises.** Step 3 said the hold meant "we are not asking for money back from you later" and
step 4 said "nothing is ever taken back from money we have already sent you". Terms 6.5 and 6.6 say a
full refund or a chargeback CANCELS that payment's reward and deducts it from the next payout if it
was already paid. The sweep the owner asked for found a THIRD place he had not named: the public
terms summary on `/terms` said "we do not ask for money back" — and terms §7 recovers a reward earned
on a garage the affiliate could not earn on, so that one was contradicted by the agreement twice
over. All three corrected; the deduction is now one constant, `REFUND_RULE`, rendered in step 4 and
on the earnings screen, which is where somebody counting on a figure reads it.

A reassurance that holds in most cases is read as a guarantee on the day it does not — and the person
reading this one is owed money.

### A GATE THAT STOPPED WORKING AT THE SIXTEENTH RUN (2026-10-31)

`spendRepLink` takes a token from the per-IP bucket: 30 rep sign-ins an hour, keyed on
`x-forwarded-for`, which the dev server sets from the socket. Every run of affiliate-portal-gate spent
two of ONE bucket for `127.0.0.1` — and the new sign-out proof doubled the cost per run. On the
sixteenth run in an hour the sign-in stopped working and presented as a 30-second timeout waiting for
the dashboard, with NO page error and nothing about a limit anywhere. It read exactly like a page I
had broken, and I spent three red-proofs blaming a paragraph I had moved.

Fixed two ways, and the second matters more: the browser context now carries a per-run address in the
documentation range (the same isolation `GATE_IP` already gave the request-link clauses), and a failed
sign-in now REPORTS the bucket — "rep sign-ins from this IP in the last hour: N of 30 — THE LIMITER IS
SPENT, which is the likelier cause than the page".

**The standing lesson is the first one, not the fix:** a gate's own cumulative side effects can make
it fail, and a limiter's symptom is indistinguishable from the defect you are hunting. Three proofs
in a row came back "inconclusive" and I read them as "red" until I counted the rows.

**And one clause of mine never reached its subject.** "A pasted link opens on the section it names"
navigated from `#payment-details` to `#earnings` — a URL differing only in its FRAGMENT does not
reload the document, so the clause re-proved the hashchange listener while the on-arrival read went
untested. Deleting that read left the whole gate green. It now leaves the document first.

---

## FIVE THINGS THE OWNER ASKED FOR AFTER THE MENU (2026-11-01)

One commit, no migration: nothing here needed a schema change, which is worth saying because two of
the five sound like they would. The mobile stays NULLABLE in the database and is required at the
write surface; the seeded terms draft is a ROW in a table that already exists.

### 1. The sort code groups itself, and still stores six digits

`sortCodeAsTyped(raw, previous)` in lib/payee — `11-03-00` as the digits land, and a paste of
`11 03 00`, `110300` or `11-03-00` all settle to the same thing. What is SENT is `normaliseSortCode`,
so the grouping never reaches the database and the route's refusal is untouched.

**`previous` is the whole of the interesting part.** Deleting a separator is indistinguishable from
deleting a digit if you only look at the digits — and without the distinction the field cannot be
edited from the right: backspace over the `-` in `11-03` leaves the six digits unchanged, the
grouping puts the dash straight back, and the key appears to do nothing. The rule deletes the digit
IN FRONT of the separator, which is what somebody means by it.

Asserted both ways: the pure table over eleven shapes, the field itself typed one key at a time
(`pressSequentially`, because `fill()` would prove the paste path twice over), and **what the form
sends, read off the wire** — the request is intercepted and answered in the gate rather than allowed
through, because a real submit would supersede the pending payee request the Engine Room clauses
below it still read. A gate's own side effects breaking its own later clauses is the shape of defect
that cost three red-proofs here a day earlier.

### 2. The favicon came off the board

See the measurement above. The middleware comment now records it as a decision: *a door opened
because it was easy is a door nobody later remembers deciding to open.*

### 3. Terms opens inside the portal, showing what THEY accepted

The menu's Terms pointed at `/terms`, the PUBLIC page. A signed-in affiliate clicking an item in
their own menu left the portal, lost the menu, and landed on the page written for somebody deciding
whether to join — and it answered the wrong question, because the person asking is asking "what did
I agree to, and when".

`pages/affiliate-portal/terms.tsx` at **`/my-terms`**, inside the same shell, with the Terms item
marked current (the shell now takes a `PortalNavKey`, not a section key — an item that highlights on
six screens and goes dead on the seventh reads as a bug). The address lives in ONE place, the nav
table, which middleware imports: the same arrangement lib/party-portal exists for. It is NOT `/terms`
because that address belongs to the public page on the same host, and one address serving two
audiences would mean deciding who is asking from a cookie, in middleware, per request.

**It shows the version they accepted, not the current one.** `RepTermsAcceptance.version` is frozen
at acceptance and the page reads the DOCUMENT behind it; a newer published version is NAMED with a
link to the public page rather than quietly swapped in. Showing today's text under "you accepted
this" would be a claim about somebody's agreement that changes without them.

**Three states, and the middle one is real:**

  • a version and a date — they accepted a published document, and it is shown;
  • a date and NO version — they accepted the SETTLED SUMMARY, before anything was published. This is
    the state the owner's own affiliate row is in. Inventing a stamp would reference words that never
    existed under that name;
  • neither — said plainly, with a phone number, and never filled in with today.

**The settled summary left the page it was written on.** It was a literal array inside
pages/affiliate-site/terms.tsx, which was right while one page showed it; two statements of one
agreement is one of them being out of date, which is exactly how the refund promise came to be wrong
in three places at once the day before. `lib/affiliate-terms-summary` is a leaf, no figure typed into
it, read by both screens — and the gate asserts the words are on both RENDERED pages and in NEITHER
page file, so they cannot have come from anywhere else.

**The acceptance line moved off the dashboard footer**, where it only appeared when there WAS a
version — so an affiliate who accepted the summary saw nothing at all. That removed the last reader
of `PortalData.terms`, and with it two of the nine queries in the dashboard's chain: the terms
document and the acceptance row. `currentVersion` had never been rendered by anything.

**And the new page joined the promises sweep the same day it was written.** Four surfaces now, not
three. The three the owner found were in three different files.

### 4. The v1 terms text is seeded as an unpublished draft

`lib/content-seed`: a registry of documents whose first draft ships in the repository, and one of
them. It fires the first time the owner opens **Engine Room → Content**, from the file that shipped
with the deploy.

**Not at build, which is what "at deploy" sounds like.** A build writing rows writes from a build
container, on every build including every preview, against whatever `DATABASE_URL` that environment
holds — and dev and production share one database here. The shape used instead is
`getProgrammeSettings`'s: the row is made by the first person who needs it, inside a request that is
already authenticated, owner-only because the one registered document is `legal`.

**Two guards, answering different questions.** Any row for (slug, country) means there is nothing to
seed. A prior `document.seeded` audit row means it has already happened *even if nothing is there
now* — which is the case the first guard cannot see: discarding the draft deletes the row, and
without this the seed would put it back on the next page load for ever. A deletion record cannot
reference its subject; the audit row IS the evidence and outlives what it is about.

It never publishes and cannot: status `draft`, the DRAFT sentinel, no effective date, `created_by`
NULL because no operator did it. **The body goes in UNBAKED**, placeholders intact, exactly as
`publish-affiliate-terms.mjs --write` leaves it — baking now would mean the owner's next edit started
from substituted text and lost the placeholders for ever. Publishing is what bakes them, refuses an
unresolved one, and spends a version: his separate step, after the solicitor.

`content/**` is traced into the serverless function (next.config.js), the same mechanism the locale
JSON needed and for the same reason: the tracer cannot see a path built from `process.cwd()` at
runtime, and an untraced file is simply absent in production while the seed reports `no_file` for
ever. That one is asserted by reading the source, because a build-time include has no other witness.

### 5. The mobile is required at signup

Required, labelled "Mobile", a plausible UK mobile, still unverified. `refuseSignupMobile` in
lib/phone-format returns the SENTENCE rather than a boolean, so the page and the endpoint say the
same words — a person correcting a field until the page is happy must not then be refused by the
route in different language.

**Plausible is the whole claim, and the name says so.** `07` and nine more digits, however it is
written. It is not evidence the number exists, belongs to them, or can receive a message; the SMS
step still proves that and `phone_verified_at` stays null. A landline is refused rather than
accepted, because a real number that cannot do the one thing the field is for would leave a garage
stalled at a step it can never pass.

**Blank is its own sentence**, because the fix is different: type something, rather than correct
something.

The write is now UNCONDITIONAL inside the transaction — there is no `if` left to hide a signup that
quietly stored no number — and the refusal happens before the password is hashed.

**The blast radius was three gates, not one.** came-via, attribution and operator-alerts all sign a
garage up through the real form; without a mobile each would have waited for a page that never
arrives. Every gate garage now gives `07700900123` — Ofcom's reserved drama range, allocated to
nobody, because a made-up 07 number is somebody's phone and these garages end up in alert rows a
person might one day ring.

**And one clause had its premise removed.** "A skipped mobile writes nothing at all" was about a
state the form can no longer produce. It is replaced by the fact that now matters — every signup
carries one, on the PERSON and not on `Group.phone` — and the onboarding comparison it fed keeps its
other arm by DELETING the TwoFactorSecret row from one fixture: "a garage from before the field was
required" is a real population, every garage that signed up while it was optional, not a fixture
artefact.

### What the red-proofs caught in the clauses themselves

  • **"it does not invent a date" swept the whole page for today's date** — and went red on correct
    code, because version 2 was published with today's effective date and the "a newer version
    exists" notice names it legitimately. The claim is about the acceptance SENTENCE, so that is what
    it asserts now. A term has to be unique to its subject.
  • **A fallback title identical to the file's own heading** made its clause unprovable: one string
    standing in for two facts, so it could not tell "the heading won" from "the fallback was used".
    The oracle is now the file's first line, parsed a different way from the function under test.
  • **The menu-walk clause failed by TIMEOUT**, which killed the run and took the forty clauses after
    it. Caught now, so a Terms item pointing elsewhere is a red.

### AND IT SHIPPED WITH A DEAD MENU (owner, on the live site, 2026-11-01)

From `/my-terms` every section item did nothing. The shell rendered a bare `#key` wherever it was
mounted, so off the dashboard each item pointed at `/my-terms#earnings` — a page with no panes and
no `hashchange` listener. Six items that look alive and are dead.

`sectionHref(key, from)` in the nav leaf: bare on the dashboard, the dashboard's own path anywhere
else. NOT absolute everywhere, which would also have fixed it and would re-pay `affiliatePortalData`'s
whole chain to move between panes of a page already open — the latency this menu is sections-not-pages
for. The rule depends on where the menu IS, which is what `active` already says, so it is a function
of both rather than a conditional inside the component.

**Every clause that missed it started on the dashboard.** Section 4a walks all six items with the
dashboard already open, where a bare hash is correct. 10b walked INTO the terms page and stopped
there. Nothing walked OUT. The new clauses start on `/my-terms`, return to it before each click, and
assert the landing — the dashboard, that section visible, and only that one. The red-proof prints the
owner's bug back verbatim, six times: `/my-terms#earnings · visible: none`.

**The standing lesson:** a shared component's correctness can depend on where it is mounted, and a
menu asserted only from its first home is asserted on one of its mountings. The second page to mount
it is where the assumption shows.

---

## THE PAYEE TIDY-UP (owner, 2026-11-01)

Four small things on the payee screens, no migration. The premise of the first one was checked
before it was acted on: `Rep.bank_account_name` is a plain `String?` — the sort code and account
number beside it are ciphertext — and `listAffiliates` simply never selected it. So it was a display
gap, as reported, and the data was never lost.

### The name beside the digits

The Engine Room card showed `••••6635` and nothing else, so the question somebody is actually asking
at a payment run — *is this the person I think I am paying?* — could only be answered by REVEALING
the digits, which writes an audit row for a look nobody needed. The name is readable precisely
because it has to be printed on a payment, so showing it costs no key and writes no row; the clause
asserts both halves, including that no reveal was recorded.

**The affiliate's own screen already showed it.** `payee-masked` has rendered "Name — ending ••21"
since the portal shipped. Left alone, and a clause put on it instead — the owner asked for the
behaviour, and the way to keep behaviour is to assert it, not to rewrite it.

### Correcting a name, and nothing else

`correctPayeeName` in lib/payee-admin. It names ONE column, so there is no sort code in the
argument for a caller to pass and no later edit of a shared object can smuggle one through. It never
decrypts: correcting a name is not a reveal and must not write one. The gate reads the ciphertext
back byte-for-byte after a correction, and the red-proof — making it also write `bank_sort_code` —
reddens exactly that clause.

**Two subjects, said rather than guessed:** the name on the Rep row (what a payment run would
print), or the name on a PENDING request (corrected before it is applied). An APPLIED request is
deliberately not editable — that row is the record of what was asked for, and rewriting it would
edit history to fix the present. The endpoint refuses a body naming both rather than resolving it.

**A no-op is refused, not audited.** A row saying a name changed from X to X is a record of an act
that did not happen. And the audit row carries BOTH values, because "the name was corrected" without
the old one cannot answer the question somebody will ask.

**The affiliate is told, and the write does not wait on the telling.** Money first, then the
secondary guard: the correction commits, then the email, and a failed send does not undo it. What
happened to the send is reported back in three states, and the screen prints it — "they were NOT
emailed" is the case that needs a phone call, and a silent success would leave the owner believing
they had been. On the gate database every send is refused by the Environment marker, so that is the
branch the clause asserts, through the NotificationLog row that proves it went through the chokepoint
rather than around it.

### Two one-liners

The mobile is formatted with the alerts' own formatter — `+44 7700 900333`, not `447700900333`, on
the screen where you decide to ring. The clause asserts the RAW form is ABSENT as well as the pretty
one present: a clause that only looked for the formatted version would pass on a row printing both.

And the waiting sentence stopped promising an account to people who have not given us one. It said
"We will pay the account we already hold until then" to everybody with a request in flight.
`holdsAccount` is its own fact on the payee props because nothing else could tell the two cases
apart — the state is 'pending' in both, and the mask shown while pending is the NEW account's.

### What the gates caught in this batch

**One template added without declaring its audience.** operator-alerts-gate enumerates the WHOLE
registry against a declared platform/tenant set, so a new template cannot be added without the
choice being made — and it went red naming mine the first time the core tier ran. Declared, and
red-proved by giving it the tenant shell.

**And then a careless restore made it worse.** Undoing that red-proof by replacing the first
`html: shell(` in the file turned the MOT REMINDER into a platform-footer email and left the new
template on the tenant one. The same clause caught it at once. Fixed by line number and verified by
diff. The lesson is dull and absolute: copy the file before a proof, and restore from the copy —
never from a pattern that is not unique to its subject.


---

## 2026-11-01 — "Database error: P2002. Check your schema constraints. [catch]"

A real signup, through the owner's own affiliate link, answered with that on the screen. Three
faults in one sentence: an internal error code, an instruction for the READER to check a schema they
have never seen, and no way forward. Underneath it the fact was ordinary and sayable.

### The cause was two columns and one check

`register-garage` pre-checked **`User.email`**. The first statement in its transaction writes
**`Group.billing_email`**, which carries its own `@unique`. So an address held by a GARAGE with no
account on it passed the check and collided inside the transaction.

Read-only against production first, before anything was changed: zero `User` rows for that address,
one `Group` — GB-GD1967, whose billing email it is. **No partial rows anywhere**: 0 groups created
in 36 hours, 0 TwoFactorSecret rows on that mobile, 0 verification tokens, 0 attributions. The
P2002 hit the first statement, so the rollback had nothing to undo — luck of ordering, not a
property, which is why the counts are now a clause.

### The mobile was never involved, and stays non-unique

There is no unique index on `phone_e164` at all. The owner decided the same day that there should
not be: a couple running a garage share a number, and the field exists to help us set them up, not
to identify anybody. The *sentence* for a mobile clash is registered in the mapping anyway so it
never has to be invented under pressure, and **both halves are asserted** — that the registry
answers it plainly, and that nothing can raise it. Add a unique index and that clause goes red
naming the decision. A registered message for an impossible conflict is a blindfold unless the
impossibility is asserted beside it.

### The second branch of that catch was worse than the sentence

    } else if (typeof err?.message === 'string') { clientMessage = err.message; }

Any internal error's text, straight to the browser. That is a disclosure path, not a wording
problem, and the clause for it posts an error carrying a host, a user and a password and asserts
none of it survives. (Written as fields rather than as a database URI because gitleaks blocks one in
this public repo, and the remedy for a false positive is not a per-line exception to that rule.) The page had the same shape: it concatenated `payload.where` (hence
`[catch]`) and fell back to the RAW body, which on a bad day is an HTML error page.

### What shipped

`lib/signup-refusals.ts` holds every word this endpoint may say about a failure — one leaf, read by
the route AND by /register, because a sentence written twice drifts and the drift shows up as a
person being told two different things about one problem. It imports **no Prisma**: /register
imports it, so a `Prisma` at module scope would ship the client to the browser. A P2002 is
recognised by its shape instead.

**Three outcomes, not two.** A conflict we can name; a conflict we cannot name (409 with the generic
sentence — the status can be honest even when the words cannot be); and not a conflict at all (500).

**The registry's order is load-bearing**: `billing_email` contains `email`, so the billing row must
be tested first or every garage-level clash is answered with "reset your password" — advice that
leads nowhere, because there is no account to reset. The two email cases are different situations
and get different advice; a clause asserts the two sentences are not the same string.

**The pre-check now reads both columns**, so the refusal costs nothing: no bcrypt hash, no
transaction, no group `ref` burned out of the sequence by an insert that rolls back. The mapping
stays as the net for the race no pre-check can close. The clause that tells the two apart is the
endpoint's own stage marker (`where: 'unique'` vs `'conflict'`), and that is stated rather than
dressed up as something stronger.

**And the number in a refusal is the number on the site.** `COMPANY.phone`, never a literal — the
clause reads the one `tel:` link off the rendered /register page and asserts the message carries
that same string.

### Item (c): nothing after the commit may report a failure

The verification token and the email sat in the same `try` as the transaction. A throw there
answered **500 for a signup that had succeeded** — the person tries again and is told the address is
taken, by their own account, created seconds earlier.

The tail is now wrapped in a catch that logs and changes nothing but `verifySent`, and the structural
rule is asserted: **between the commit and the 201 there is not one `return res`**, while the
commit's own catch must return. One must, the other must not.

`/onboarding/check-email` was one long claim that a link had been sent. It reads the endpoint's
answer now, and when the send failed it says the account exists, gives the number, and drops "try
registering again" — which is a refusal now, by their own address.

**What is driven and what is not, plainly.** The failed-send arm is real in the gate: no provider is
configured and the Environment marker refuses real sends, so every signup there exercises it and the
NotificationLog row proves it. A *throw* in that tail is not driven — nothing reachable from a
signup can be made to throw there without putting a test hook in the route — so that half rests on
the structural clause.

### And the day the suite's own numbers lied — one column on ZZ

Running the three tiers for this slice gave **core 28 RED against a baseline of 16**, and **slow 24
against 13**. None of it was the slice: stashing all six files and re-running slow gave the same
24, gate for gate.

The cause was one column. **`ZZ Gate Garage.is_internal` was `null`, not `true`.** `lib/onboarding`
returns early only for a tenant that will never subscribe, and `is_internal` is how ZZ qualifies;
without it ZZ walks the real onboarding, stops on the phone step it has no record for, and **its
dashboard is locked**. Every gate needing a job card or a dashboard then times out on a selector
that will never appear. `getOnboardingState(ZZ)` said it in one line:
`{ onboarded: false, firstIncompleteStep: 'phone' }`.

**How it got there, and why it stuck.** `free-tenant-gate` clears `is_internal` deliberately, as a
fixture, to prove the free decision alone silences the subscription banner — and restores it in a
`finally`. It **hung and was killed after 300s**, and a killed process never reaches its `finally`.
That alone is an afternoon. What made it a day is the shape of the restore: both free-* gates
captured `is_internal` at the start of the run and put *that* value back, so every run afterwards
captured the `null`, restored it faithfully, and asserted — correctly — that teardown had restored
every flag. **The corruption became self-perpetuating, and the clause that should have caught it
agreed with it.** A capture-and-restore teardown can only preserve what the previous run left.

So the resting state is now DECLARED, as `ZZ_RESTING_INTERNAL` beside `ZZ_GROUP` in the preflight.
Both gates restore that value rather than what they found, and both assert ZZ starts internal — the
next killed run costs one red line. `free-reconcile`'s teardown compares against the capture with
`is_internal` declared, so a run that repairs the corruption reads as restored rather than as a
failed teardown, which is what would otherwise have undone the fix.

The owner authorised the one-column repair (`GB-GD2141`, `is_internal → true`); the script checked
the ref AND the group name and refused anything else. Core went straight back to **99 green / 16 RED**.

**And one of mine, found on the way.** `came-via-gate` had
`subject_id: skipped.user?.id` on a `twoFactorSecret.deleteMany`. In Prisma an `undefined` in a
where clause is an OMITTED FILTER, not a match on nothing — so a fixture that failed to sign up
would have turned that line into "delete every tenant's mobile record in the database", which is
exactly the state that locks ZZ. It never fired. It was one failed fixture away.
