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
