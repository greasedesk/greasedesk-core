-- Date of the most recent MOT test (DVSA). Additive.
ALTER TABLE "Vehicle" ADD COLUMN "last_mot_date" DATE;
