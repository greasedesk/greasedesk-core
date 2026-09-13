-- @migration: additive
--
-- INTERNAL PREP CARDS: one nullable column linking a job card to the stock item it is preparing.
--
-- ADDITIVE: one nullable ADD COLUMN, NO foreign key, no index, no backfill. The FK is omitted on
-- purpose and not by oversight — JobCard is written constantly by deployed code, so ADD CONSTRAINT
-- against it would be a constraining migration needing two pushes on a database dev and production
-- share. Invoice.stock_disposal_id was decided the same way for the same reason.
ALTER TABLE "JobCard" ADD COLUMN "stock_item_id" TEXT;

COMMENT ON COLUMN "JobCard"."stock_item_id" IS
  'The StockItem this card is preparing. NULL = an ordinary customer card. Set = internal prep: bills nobody, parts accrue to that car cost base, every invoice path refuses it. The link IS the flag - there is deliberately no separate boolean to disagree with it.';
