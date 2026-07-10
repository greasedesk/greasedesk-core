-- Labour hours: the notional labour CONTENT of a fixed-price service (charged hours — NOT booking
-- duration, NOT actual worked hours). Set once on the service definition, inherited by each job's
-- quote line, frozen into the invoice snapshot. Additive/nullable — existing services need hours
-- set by the admin before the dashboard hours tile is meaningful.
ALTER TABLE "CatalogueItem" ADD COLUMN "labour_hours" DECIMAL(6,2);
ALTER TABLE "JobCardItem"   ADD COLUMN "labour_hours" DECIMAL(6,2);
ALTER TABLE "InvoiceLine"   ADD COLUMN "labour_hours" DECIMAL(6,2);
