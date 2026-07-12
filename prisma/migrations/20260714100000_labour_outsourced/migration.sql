-- Outsourced/bought-in labour (cost of sale, invisible to utilisation). ADDITIVE.
-- Product flag + line-level inheritance at explosion (frozen history stays honest on re-flag).
ALTER TABLE "CatalogueItem" ADD COLUMN "labour_outsourced" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobCardItem" ADD COLUMN "labour_outsourced" BOOLEAN NOT NULL DEFAULT false;
