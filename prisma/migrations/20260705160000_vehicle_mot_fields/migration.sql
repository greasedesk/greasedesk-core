-- DVSA MOT History capture (banked service-reminder feature). Additive.
ALTER TABLE "Vehicle" ADD COLUMN "mot_expiry" DATE;
ALTER TABLE "Vehicle" ADD COLUMN "last_mot_mileage" INTEGER;
