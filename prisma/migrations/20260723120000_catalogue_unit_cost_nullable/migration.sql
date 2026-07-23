-- CatalogueItem.unit_cost → NULLABLE. Additive: existing values (including zeros) are UNCHANGED —
-- we do not guess historical intent. null = cost not entered (flagged uncosted); a number (incl 0 =
-- legitimately free) = known. Mirrors the null/zero discipline already on InvoiceLine/JobCardItem.
ALTER TABLE "CatalogueItem" ALTER COLUMN "unit_cost" DROP NOT NULL;
