-- @migration: additive
--
-- PROJECTED SALE PRICE: one nullable column, so a car in stock can carry what we expect to get.
--
-- ADDITIVE: one nullable ADD COLUMN, no constraint, no backfill, no index. Nullable because NULL is a
-- real answer -- nobody has estimated it yet -- and a 0 default would read as "we expect nothing for
-- this car", which the projection would faithfully report as a loss on every car ever bought.
ALTER TABLE "StockItem" ADD COLUMN "projected_sale_pence" INTEGER;

COMMENT ON COLUMN "StockItem"."projected_sale_pence" IS
  'What we expect to sell it for. An estimate the garage states, not a measurement. NULL = not estimated, and the projection shows nothing rather than a loss. Meaningless once disposed - StockDisposal.sale_pence is then the answer.';
