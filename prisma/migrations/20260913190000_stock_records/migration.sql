-- @migration: additive
--
-- STOCK RECORDS, slice one. Three new tables and one nullable column.
--
-- ── WHY THIS IS ONE PUSH, DECIDED BEFORE IT WAS WRITTEN ─────────────────────────────────────────
-- CREATE TABLE is self-contained additive: its own foreign keys, CHECKs and UNIQUEs constrain inserts
-- into tables production has never heard of. What would have made this constraining is a foreign key
-- pointing the OTHER way — from an existing table into a new one — because that is ALTER TABLE ADD
-- CONSTRAINT against rows production is writing this second.
--
-- So every link points FROM the new tables TO the old ones, and "Invoice"."stock_disposal_id" is a
-- plain nullable column with NO REFERENCES clause. That follows the precedent already written into
-- PurchaseModel.vehicle_id: the constraint is worth having, and it is worth having BY ITSELF, in a
-- later migration containing nothing but foreign keys, once the code that writes these ids is
-- deployed. A constraining migration tangled into a feature is the one nobody can roll back.
--
-- ── ONE DISPOSAL PER ITEM IS UNIQUE *INSIDE* THE TABLE ──────────────────────────────────────────
-- Not a separate CREATE UNIQUE INDEX. That statement classifies CONSTRAINING even on a brand-new
-- table — the classifier matches the statement, not the table's age — and would have cost a second
-- push for a rule the table can state about itself.
--
-- ── NO UPDATE, NO DELETE ────────────────────────────────────────────────────────────────────────
-- Nothing here rewrites a row. Backfilling existing vehicles into stock is a script with the owner's
-- say-so, run once and audited, not a migration that runs itself on every environment for ever.
--
-- ── NO CHECK ON `kind` OR `vat_status`, DELIBERATELY ────────────────────────────────────────────
-- The vocabularies live in lib/stock (DISPOSAL_KINDS) and lib/purchase-model (VAT_STATUSES) and the
-- writer is asserted to use them. A CHECK here would make adding a sixth way for a car to leave an
-- ALTER TABLE DROP/ADD CONSTRAINT — constraining, two pushes — for a list that will grow. Same
-- considered exception as PurchaseModel.status, and for the same reason.
CREATE TABLE "StockItem" (
    "id"                 TEXT NOT NULL,
    "group_id"           TEXT NOT NULL,
    "vehicle_id"         TEXT NOT NULL,
    "acquired_at"        TIMESTAMP(3) NOT NULL,
    "purchase_pence"     INTEGER NOT NULL,
    "vat_status"         TEXT NOT NULL,
    "source"             TEXT NOT NULL,
    "premium_pence"      INTEGER NOT NULL DEFAULT 0,
    "services_pence"     INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id"),
    -- Money is never negative here; a negative purchase is a typo, not a case.
    CONSTRAINT "StockItem_amounts_chk" CHECK ("purchase_pence" >= 0 AND "premium_pence" >= 0 AND "services_pence" >= 0),
    CONSTRAINT "StockItem_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    -- RESTRICT, not CASCADE: deleting a vehicle that is in stock would delete the record asserting the
    -- garage owns it, which is a compliance record. The delete should fail and be dealt with.
    CONSTRAINT "StockItem_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX "StockItem_group_id_acquired_at_idx" ON "StockItem"("group_id", "acquired_at");

CREATE TABLE "StockDisposal" (
    "id"                 TEXT NOT NULL,
    "group_id"           TEXT NOT NULL,
    "stock_item_id"      TEXT NOT NULL,
    "disposed_at"        TIMESTAMP(3) NOT NULL,
    "kind"               TEXT NOT NULL,
    -- NULL for the three kinds that are not sales. An honest null, never a zero: a scrapped car did
    -- not sell for nothing, it did not sell.
    "sale_pence"         INTEGER,
    "note"               TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockDisposal_pkey" PRIMARY KEY ("id"),
    -- ONE DISPOSAL PER ITEM, stated by the table about itself.
    CONSTRAINT "StockDisposal_stock_item_id_key" UNIQUE ("stock_item_id"),
    CONSTRAINT "StockDisposal_sale_chk" CHECK ("sale_pence" IS NULL OR "sale_pence" >= 0),
    CONSTRAINT "StockDisposal_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "StockDisposal_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "StockDisposal_group_id_disposed_at_idx" ON "StockDisposal"("group_id", "disposed_at");

CREATE TABLE "StockCostSnapshot" (
    "id"            TEXT NOT NULL,
    "group_id"      TEXT NOT NULL,
    "stock_item_id" TEXT NOT NULL,
    "kind"          TEXT NOT NULL,
    "description"   TEXT NOT NULL,
    "amount_pence"  INTEGER NOT NULL,
    -- NO FOREIGN KEY to JobCard, on purpose: an admin can hard-delete a card, and a frozen cost must
    -- survive that. The snapshot IS the record; it is not a view of one.
    "job_card_id"   TEXT,
    "captured_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCostSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StockCostSnapshot_amount_chk" CHECK ("amount_pence" >= 0),
    CONSTRAINT "StockCostSnapshot_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "StockCostSnapshot_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "StockCostSnapshot_group_id_stock_item_id_idx" ON "StockCostSnapshot"("group_id", "stock_item_id");

-- THE REFERENCE, WITHOUT THE CONSTRAINT. See the header: this is what keeps the slice to one push.
ALTER TABLE "Invoice" ADD COLUMN "stock_disposal_id" TEXT;
