-- ONE REPORTING ANCHOR PER TENANT.
--
-- Clipping used to be opt-in per dashboard tile: three computes clipped to the earliest record and
-- four did not, so net profit charged twelve months of payroll against five months of trading and
-- sat beside a five-month cost base. The anchor makes the frame explicit and owned by the garage.
--
-- NOT NULL, deliberately. Nullable would mean "nobody set it", which is a state the reader cannot
-- distinguish from "set to the earliest record" — and the whole failure here was an invisible
-- window. Backfilled first, then constrained, so no row is ever null.
ALTER TABLE "Group" ADD COLUMN "reporting_start_date" TIMESTAMP(3);

-- Backfilled to the EARLIEST RECORD, not the signup date. Signup is wrong in the same direction on
-- every tenant checked: TMBS signed up 2026-06-28 with records from 2026-04-01 (imported history),
-- Kingsford signed up 2026-08-22 with records from 2025-08-22 (a year earlier). Defaulting to
-- signup would silently discard real data and look perfectly consistent doing it.
--
-- Truncated to the month so a period is whole months: the anchor is read back as "reporting starts
-- September 2025", and a mid-month start would make every month count fractional.
-- LEAST ignores NULLs in Postgres; a tenant with no records at all falls back to its signup date.
UPDATE "Group" g SET "reporting_start_date" = date_trunc('month', COALESCE(
  LEAST(
    (SELECT MIN(i."date_issued") FROM "Invoice" i WHERE i."group_id" = g."id"),
    (SELECT MIN(c."created_at")  FROM "JobCard" c WHERE c."group_id" = g."id")
  ),
  g."created_at"
));

ALTER TABLE "Group" ALTER COLUMN "reporting_start_date" SET NOT NULL;
-- New tenants anchor at signup, which for them IS the earliest record.
ALTER TABLE "Group" ALTER COLUMN "reporting_start_date" SET DEFAULT CURRENT_TIMESTAMP;
