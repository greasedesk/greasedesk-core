-- @migration: additive
--
-- STOCK LIFECYCLE: when the car actually turned up, and where it is in its life.
--
-- ADDITIVE: two ADD COLUMNs, no constraint, no backfill, NO UPDATE. The status default is carried by
-- the column definition, which Postgres applies without rewriting the table and without this file
-- containing an UPDATE -- an UPDATE would classify as constraining and cost two pushes.
--
-- arrived_at is NULLABLE and deliberately NOT backfilled. Every reader falls back to acquired_at
-- through one place (lib/stock::stockClock), so no car already recorded changes its days-in-stock.
--
-- acquired_at is UNTOUCHED and keeps its meaning: when you bought it. The book's period boundary
-- reads it, and ownership starts at purchase whether or not the car is on your premises. Renaming it
-- would have moved cars between quarters.
ALTER TABLE "StockItem" ADD COLUMN "arrived_at" DATE;
ALTER TABLE "StockItem" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'in_prep';

COMMENT ON COLUMN "StockItem"."arrived_at" IS
  'When the car turned up. NULL = not yet arrived (Due In). Days in stock counts from here, falling back to acquired_at so nothing already recorded moves.';
COMMENT ON COLUMN "StockItem"."status" IS
  'due_in | in_prep | advertised | reserved. EXPLICIT, never derived from other data. Sold is not here - a sold car is one with a StockDisposal.';
