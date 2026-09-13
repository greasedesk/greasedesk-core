-- @migration: additive
--
-- Auction-invoice attributes captured when a car is taken into stock.
--
-- ADDITIVE ONLY: four nullable ADD COLUMNs, no constraint, no backfill, no index. Every column is
-- nullable because NULL is a real answer for all four — "nobody recorded this" — and not a gap
-- waiting to be filled. Deployed writers keep working unchanged, which is what makes this one push
-- rather than two on a database dev and production share.
ALTER TABLE "Vehicle" ADD COLUMN "first_registered" DATE;
ALTER TABLE "Vehicle" ADD COLUMN "is_import" BOOLEAN;
ALTER TABLE "Vehicle" ADD COLUMN "v5c_reference" TEXT;
ALTER TABLE "StockItem" ADD COLUMN "mileage_warranted" BOOLEAN;

COMMENT ON COLUMN "Vehicle"."v5c_reference" IS
  'V5C logbook reference. Credential-grade: transfers keepership and taxes the car. Redacted from audit diffs by lib/redact and never returned by an API. Do not add to a SELECT that feeds a response.';
COMMENT ON COLUMN "Vehicle"."is_import" IS
  'Tri-state. NULL = not recorded, TRUE = import, FALSE = UK-supplied (a positive statement).';
COMMENT ON COLUMN "StockItem"."mileage_warranted" IS
  'Tri-state term of THIS purchase. NULL = not stated. The car does not inherit it.';
