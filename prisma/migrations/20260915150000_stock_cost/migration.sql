-- @migration: additive
--
-- PER-CAR COSTS BESIDES PARTS: delivery in, valeting, MOT -- and the credits that reverse them.
--
-- SELF-CONTAINED ADDITIVE, so ONE push. Every foreign key points FROM this new table TO tables that
-- already exist, and each is declared INSIDE the CREATE TABLE. What would make it constraining is a
-- key pointing the other way: that is ADD CONSTRAINT against rows production is writing this second.
--
-- The keys are inlined rather than added afterwards for the same reason the stock-records migration
-- inlined its own: a separate `ALTER TABLE ... ADD CONSTRAINT` reads as constraining to the deploy
-- classifier whatever table it names, and the classifier is right to refuse a statement it cannot
-- prove is safe rather than to reason about what was created a line earlier.
CREATE TABLE "StockCost" (
    "id"                 TEXT NOT NULL,
    "group_id"           TEXT NOT NULL,
    "stock_item_id"      TEXT NOT NULL,
    "kind"               TEXT NOT NULL,
    "description"        TEXT NOT NULL,
    "amount_pence"       INTEGER NOT NULL,
    "incurred_on"        DATE NOT NULL,
    "vat_treatment"      TEXT NOT NULL,
    "reverses_id"        TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCost_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockCost_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "StockCost_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "StockCost_group_id_stock_item_id_idx" ON "StockCost"("group_id", "stock_item_id");

COMMENT ON COLUMN "StockCost"."amount_pence" IS
  'GROSS and ALWAYS POSITIVE, including on a credit. The sign is carried by reverses_id, never by a negative number.';
COMMENT ON COLUMN "StockCost"."reverses_id" IS
  'This row is a CREDIT against that cost. NULL = an ordinary cost. The credited row stays: the truth is money out and money back, not a car that never had the part.';
