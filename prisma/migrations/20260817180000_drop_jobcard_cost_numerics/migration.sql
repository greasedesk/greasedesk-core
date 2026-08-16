-- Drop JobCard.labour_cost_numeric and parts_cost_numeric. They were WRITE-ONLY.
--
-- Written on every quote save since the init migration (20251110), copied by jobcard-duplicate,
-- and READ BY NOTHING — not a figure, not a tile, not a gate, not a golden. They predate the
-- current costing model, which reads cost from the lines (JobCardItem.unit_cost) and from the
-- frozen InvoiceLine grain after issue.
--
-- Removed rather than left in place with the writes stopped. A stale column is exactly what a
-- future margin question reaches for and TRUSTS: it has a plausible name, a plausible type, and
-- values that were correct on the day they were last written. That is worse than no column.
--
-- Safe to drop: all 43 JobCard reads in lib/ and pages/ use an explicit select or include, so
-- these were never in an API response and no client can be depending on them.
--
-- The two BILL numerics (labour_bill_numeric, parts_bill_numeric) deliberately stay for now — the
-- WIP tile still reads them. They go once it derives from the lines, and not in the same step.

ALTER TABLE "JobCard" DROP COLUMN "labour_cost_numeric";
ALTER TABLE "JobCard" DROP COLUMN "parts_cost_numeric";
