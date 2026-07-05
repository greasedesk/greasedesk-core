-- DVLA VES + make/model capture fields on Vehicle. Additive (make/model/fuel_type/year already exist).
ALTER TABLE "Vehicle" ADD COLUMN "colour" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "engine_cc" INTEGER;
