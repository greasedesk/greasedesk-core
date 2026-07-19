# Undated configuration exposure

**The asymmetry, in one sentence:** the ledger side is **frozen at issue** and safe, while everything
feeding **capacity, wages and overheads** is **recomputed from today's configuration** for any
historical window — so changing a setting today can silently rewrite a closed month.

Recorded 2026-07-19, after the effective-dated site-hours slice.

## Why the ledger is safe

At issue, an invoice snapshots its lines: `line_total`, `unit_price`, `unit_cost`, `line_vat`,
`vat_registered_at_issue`, `company_name_snapshot`, `customer_name_snapshot`. The P&L and VAT return
read those frozen rows (`fetchLedgerInvoices` → `InvoiceLine`), never the live card or catalogue.
Re-pricing a catalogue item, changing the VAT rate, or renaming the company therefore cannot move a
figure that has already been issued. That is the freeze-at-issue rule working as designed.

## Why the capacity side is not

`getAvailableHours`, `monthlyWageBill` and `monthlyOverheads` take a *window* and compute from
whatever the configuration says **right now**. There is no snapshot. A window in March is answered
with July's salaries, July's overheads, July's labour rate.

Two things are already protected, by different mechanisms:

- **`utilisation_factor`** — evented AND read value-at-time (`factorsAtWindowEnd`, the first such
  read in the system).
- **`Site.open_days`** — evented AND read value-at-time (`openDaysAtWindowEnd`, the second).

Everything below is not.

## The exposures, sequenced by blast radius

| # | Config | Event exists? | Read at-time? | What moves if changed |
|---|---|---|---|---|
| 1 | `CostPerson.amount_pennies` (wage) | **yes** (`wage`) | **no** — flat read | **net profit, every closed month at once** |
| 2 | `Overhead.ex_vat_amount_pennies` / `period` / allocations | **no** | no | **net profit, every closed month at once** |
| 3 | `ServiceCatalogue.LABOUR_HR.default_labour_rate` | **no** | no | **unsold-hours valuation** (June: £5,186.25) |
| 4 | `CostAllocation.percent` | **no** | no | capacity **and** wage bill — both sides at once |
| 5 | `Site.open_days` / `open_hour` / `close_hour` / `breaks` | **yes** (`open_days`) | **yes** for days; `hours`/`breaks` reserved, unused | capacity — **closed for days (2026-07-19)** |
| 6 | `CostPerson.contracted_hours_per_day` | **yes** (`hours`) | **no** — flat read | capacity, utilisation |
| 7 | `CostPerson.working_days` | **yes** (`pattern`) | **no** — flat read | capacity, utilisation |
| 8 | `CostPerson.is_chargeable` | **yes** (`chargeable`) | **no** — flat *filter* | who counts toward capacity at all |

### The cheap half

**Items 1, 6, 7 and 8 already have the history.** `EmploymentEvent` records ten kinds
(`wage`, `hours`, `pattern`, `chargeable`, `allowance`, `started`, `ended`, `name`, `factor`,
`role`), but only `factor` is read value-at-time. For these four the data is being written and then
ignored — **the gap is the read, not the write**, so each is a resolver away from correct, following
the same rule as `factorsAtWindowEnd` and `openDaysAtWindowEnd`.

Items 2, 3 and 4 have no event series at all and need the full pattern: table, migration, backfill,
resolver.

### Notes on individual items

**1 — wage.** The worst of the set. `monthlyWageBill` reads `amount_pennies` flat and feeds
`netProfit` directly, so one salary change rewrites the bottom line of every month ever reported.

**3 — labour rate.** The valuation multiplies *historical* unsold hours by *today's* rate. A rate
rise from £75 tomorrow silently restates June's £5,186.25 with no audit trail and no visible cause.

**4 — allocation percent.** Uniquely nasty because it scales **both** capacity (`getAvailableHours`)
and cost (`monthlyWageBill`). Moving a mechanic between sites retrospectively rewrites both sides of
the margin for every prior month.

**5 — site hours.** Days closed on 2026-07-19. `open_hour`/`close_hour` and `breaks` remain flat: no
change has occurred, so no event exists, and the resolver's fallback returns the flat column. The
enum reserves both kinds so the shape is already there when times do change. **Note that day length
is still undated** — a change from 09:00–18:00 to 08:00–18:00 would retrospectively lengthen every
historical day.

## Already dated, no action

`PublicHoliday` and `LeaveRecord` carry their own dates and are read by date. `Invoice.date_issued`
/ `date_paid` resolve through `effectiveIssueDate` / `effectivePaidDate`.

## The rule going forward

If a value feeds a number that is reported for a *past period*, it needs to be effective-dated
before it is edited in anger. The resolution rule is settled and identical in both existing readers:

1. latest non-voided event with `effective_date < T` → its `value_json`
2. else, if a later event exists → the **earliest** later event's `previous_json`
3. else → the flat column

Rule 2 is what lets **one** event represent both eras, so no origin backfill is ever needed.
