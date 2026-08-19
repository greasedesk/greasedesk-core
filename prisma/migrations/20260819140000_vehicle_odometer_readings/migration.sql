-- Every odometer reading we have for a car: the DVSA MOT history already arriving in a call we
-- already make, plus our own readings at the car. Additive only — one table.
-- The unique key makes re-lookup an idempotent upsert: the DVSA lookup fires on every reg search.

-- CreateTable
CREATE TABLE "VehicleOdometerReading" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reading_date" DATE NOT NULL,
    "miles" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleOdometerReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleOdometerReading_group_id_vehicle_id_reading_date_idx" ON "VehicleOdometerReading"("group_id", "vehicle_id", "reading_date");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleOdometerReading_vehicle_id_source_reading_date_key" ON "VehicleOdometerReading"("vehicle_id", "source", "reading_date");

-- AddForeignKey
ALTER TABLE "VehicleOdometerReading" ADD CONSTRAINT "VehicleOdometerReading_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleOdometerReading" ADD CONSTRAINT "VehicleOdometerReading_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

