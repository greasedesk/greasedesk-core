-- @migration: additive
--
-- HELD ON LIFT: a car occupying its bay open-endedly, almost always awaiting parts.
--
-- A nullable timestamp rather than a boolean, because the question that gets asked is "how long
-- has that car been on bay two?" and nine days on a bay is money a boolean cannot name. NULL means
-- not held. Purely additive: no default, no backfill, no constraint — the existing `held_on_lift`
-- boolean is left in place and is read by code that is already deployed, so it is retired in a
-- later migration, after the deploy that stops reading it.
ALTER TABLE "JobCard" ADD COLUMN "held_since" TIMESTAMP(3);
