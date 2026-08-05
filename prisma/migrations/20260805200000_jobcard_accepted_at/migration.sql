-- Additive only: a nullable column. NULL on every existing row is correct and permanent —
-- acceptance dates before this existed live in AuditLog (quote.accepted / accept.booked /
-- quote.accepted_verbal) and are NOT backfilled, because three actions across four paths cannot
-- be reconciled into one column without guessing.
ALTER TABLE "JobCard" ADD COLUMN "accepted_at" TIMESTAMP(3);
