-- @migration: additive
--
-- RETURNS AND BUYBACKS: one nullable column pointing a new stock record at the sale it came back from.
--
-- ADDITIVE: one nullable ADD COLUMN, no constraint, no backfill, no index. No foreign key, because
-- StockItem is a live table and ADD CONSTRAINT against it needs two pushes on a shared database.
--
-- Note what is NOT here: nothing reverses, deletes or rewrites an existing StockDisposal. A car that
-- comes back comes back as a NEW row. The quarter that reported the sale must go on reporting it.
ALTER TABLE "StockItem" ADD COLUMN "reacquired_from_disposal_id" TEXT;

-- NOTE: no semicolon inside this string. The deploy classifier splits statements on ';' and a
-- semicolon in a comment literal leaves an unrecognised fragment, which it correctly treats as
-- constraining and refuses. Failing closed on a sentence it cannot parse is the right behaviour.
COMMENT ON COLUMN "StockItem"."reacquired_from_disposal_id" IS
  'The earlier StockDisposal this car came back from. NULL = ordinary acquisition. source=return restores the original cost base and VAT status because the sale is being reversed. source=buyback uses the price paid now, and the original sale stands. The earlier disposal is never undone.';
