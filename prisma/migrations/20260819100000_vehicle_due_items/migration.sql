-- A job the car needs that nobody is doing today: found at intake, surfaced next time.
-- Additive only — one table, two enums, no change to any existing column.
--
-- The customer is deliberately ABSENT: who to remind is resolved at reminder time through the
-- VehicleOwnership edge, because the car may change hands between the finding and the reminder.
-- due_basis is STATED rather than inferred from which of due_date/due_mileage is filled; both can
-- legitimately be present and only one binds.

-- CreateEnum
CREATE TYPE "DueBasis" AS ENUM ('date', 'mileage', 'next_service');

-- CreateEnum
CREATE TYPE "DueItemResponse" AS ENUM ('not_raised', 'declined', 'agreed_later');

-- CreateTable
CREATE TABLE "VehicleDueItem" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "found_on_job_card_id" TEXT,
    "description" TEXT NOT NULL,
    "service_catalogue_id" TEXT,
    "due_basis" "DueBasis" NOT NULL,
    "due_date" TIMESTAMP(3),
    "due_mileage" INTEGER,
    "customer_response" "DueItemResponse" NOT NULL,
    "response_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_job_card_id" TEXT,
    "closed_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleDueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehicleDueItem_group_id_vehicle_id_closed_at_idx" ON "VehicleDueItem"("group_id", "vehicle_id", "closed_at");

-- CreateIndex
CREATE INDEX "VehicleDueItem_found_on_job_card_id_idx" ON "VehicleDueItem"("found_on_job_card_id");

-- AddForeignKey
ALTER TABLE "VehicleDueItem" ADD CONSTRAINT "VehicleDueItem_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDueItem" ADD CONSTRAINT "VehicleDueItem_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDueItem" ADD CONSTRAINT "VehicleDueItem_found_on_job_card_id_fkey" FOREIGN KEY ("found_on_job_card_id") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleDueItem" ADD CONSTRAINT "VehicleDueItem_closed_job_card_id_fkey" FOREIGN KEY ("closed_job_card_id") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

