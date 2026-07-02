-- Tiered fixed-price services. ADDITIVE: 3 new tables + 1 nullable column on CatalogueItem + a
-- backfill that touches ONLY fixed items. Simple items (part/labour/misc) are untouched.

-- Tenant-defined optional tiers.
CREATE TABLE "ServiceTier" (
  "id"         TEXT NOT NULL,
  "group_id"   TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "position"   INTEGER NOT NULL DEFAULT 0,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceTier_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ServiceTier_group_id_idx" ON "ServiceTier"("group_id");
ALTER TABLE "ServiceTier" ADD CONSTRAINT "ServiceTier_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fixed-service components (cost + spec text; never a priced customer row).
CREATE TABLE "CatalogueComponent" (
  "id"                TEXT NOT NULL,
  "catalogue_item_id" TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "qty"               DECIMAL(12,2) NOT NULL DEFAULT 1,
  "unit_cost_ex_vat"  DECIMAL(12,2) NOT NULL DEFAULT 0,
  "position"          INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "CatalogueComponent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CatalogueComponent_catalogue_item_id_idx" ON "CatalogueComponent"("catalogue_item_id");
ALTER TABLE "CatalogueComponent" ADD CONSTRAINT "CatalogueComponent_catalogue_item_id_fkey"
  FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-tier price override (price_ex_vat NULL = offered-but-price-per-job).
CREATE TABLE "CatalogueItemTierPrice" (
  "id"                TEXT NOT NULL,
  "catalogue_item_id" TEXT NOT NULL,
  "tier_id"           TEXT NOT NULL,
  "price_ex_vat"      DECIMAL(12,2),
  CONSTRAINT "CatalogueItemTierPrice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CatalogueItemTierPrice_catalogue_item_id_tier_id_key" ON "CatalogueItemTierPrice"("catalogue_item_id", "tier_id");
CREATE INDEX "CatalogueItemTierPrice_catalogue_item_id_idx" ON "CatalogueItemTierPrice"("catalogue_item_id");
CREATE INDEX "CatalogueItemTierPrice_tier_id_idx" ON "CatalogueItemTierPrice"("tier_id");
ALTER TABLE "CatalogueItemTierPrice" ADD CONSTRAINT "CatalogueItemTierPrice_catalogue_item_id_fkey"
  FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CatalogueItemTierPrice" ADD CONSTRAINT "CatalogueItemTierPrice_tier_id_fkey"
  FOREIGN KEY ("tier_id") REFERENCES "ServiceTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Anchor price on CatalogueItem (nullable; only fixed items use it).
ALTER TABLE "CatalogueItem" ADD COLUMN "base_price_ex_vat" DECIMAL(12,2);

-- Backfill existing fixed items: base_price = current price (treated as EX-VAT, migrate as-is).
UPDATE "CatalogueItem" SET "base_price_ex_vat" = "unit_price" WHERE "item_type" = 'fixed';
