-- Product catalogue. ADDITIVE ONLY: new CatalogueItem table + one nullable column and a SetNull FK
-- on JobCardItem. No existing table is altered/dropped/retyped. InvoiceLine.catalogue_item_id
-- (shipped earlier, no FK) is untouched. Reuses the existing ItemType enum — no enum change.

CREATE TABLE "CatalogueItem" (
  "id"         TEXT NOT NULL,
  "group_id"   TEXT NOT NULL,
  "code"       TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "item_type"  "ItemType" NOT NULL,
  "unit_cost"  DECIMAL(12,2) NOT NULL,
  "unit_price" DECIMAL(12,2) NOT NULL,
  "vat_rate"   DECIMAL(5,2)  NOT NULL DEFAULT 20,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CatalogueItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CatalogueItem_group_id_code_key" ON "CatalogueItem"("group_id", "code");
CREATE INDEX "CatalogueItem_group_id_idx" ON "CatalogueItem"("group_id");
ALTER TABLE "CatalogueItem" ADD CONSTRAINT "CatalogueItem_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Origin hook on the card line (nullable; SetNull protects historic lines on archive/delete).
ALTER TABLE "JobCardItem" ADD COLUMN "catalogue_item_id" TEXT;
CREATE INDEX "JobCardItem_catalogue_item_id_idx" ON "JobCardItem"("catalogue_item_id");
ALTER TABLE "JobCardItem" ADD CONSTRAINT "JobCardItem_catalogue_item_id_fkey"
  FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
