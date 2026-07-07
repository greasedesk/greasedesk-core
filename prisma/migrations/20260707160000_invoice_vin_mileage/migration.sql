-- VIN + mileage on the invoice document, following the existing issue-time header-snapshot
-- pattern (post-mint vehicle edits never rewrite an issued document). Additive, nullable.
ALTER TABLE "Invoice" ADD COLUMN "vehicle_vin_snapshot" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "vehicle_mileage_snapshot" INTEGER;
