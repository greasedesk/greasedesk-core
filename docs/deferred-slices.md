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
