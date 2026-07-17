-- Ad-hoc parts cost regression (Option A): unit_cost becomes NULLABLE on the line tables, so the
-- data can distinguish "cost UNKNOWN" (null) from "cost genuinely £0" (a real 0, e.g. a discount).
-- ADDITIVE + non-destructive: existing rows keep their current value (0 stays 0 — NOT reclassified;
-- no backfill, no guessed costs). Only NEW un-catalogued ad-hoc parts will write NULL going forward.
-- CatalogueItem.unit_cost is deliberately UNTOUCHED (the product cost is always known/authored).
ALTER TABLE "JobCardItem" ALTER COLUMN "unit_cost" DROP NOT NULL;
ALTER TABLE "JobCardItem" ALTER COLUMN "unit_cost" DROP DEFAULT;
ALTER TABLE "InvoiceLine" ALTER COLUMN "unit_cost" DROP NOT NULL;
ALTER TABLE "InvoiceLine" ALTER COLUMN "unit_cost" DROP DEFAULT;
