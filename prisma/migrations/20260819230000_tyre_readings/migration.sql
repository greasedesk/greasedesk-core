-- Tyre condition: four corners, THREE readings across each tread. The three exist to expose
-- inside-edge wear, which is an alignment job a single depth hides entirely.

-- CreateEnum
CREATE TYPE "TyreCorner" AS ENUM ('front_left', 'front_right', 'rear_left', 'rear_right');

-- CreateEnum
CREATE TYPE "TyreType" AS ENUM ('summer_standard', 'summer_runflat', 'winter_standard', 'winter_runflat');

-- CreateTable
CREATE TABLE "TyreReading" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "job_card_id" TEXT,
    "corner" "TyreCorner" NOT NULL,
    "type" "TyreType" NOT NULL,
    "depth_outer_tenths" INTEGER NOT NULL,
    "depth_centre_tenths" INTEGER NOT NULL,
    "depth_inner_tenths" INTEGER NOT NULL,
    "measured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "measured_by" TEXT,

    CONSTRAINT "TyreReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TyreReading_group_id_vehicle_id_corner_measured_at_idx" ON "TyreReading"("group_id", "vehicle_id", "corner", "measured_at");

-- CreateIndex
CREATE UNIQUE INDEX "TyreReading_job_card_id_corner_key" ON "TyreReading"("job_card_id", "corner");

-- AddForeignKey
ALTER TABLE "TyreReading" ADD CONSTRAINT "TyreReading_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TyreReading" ADD CONSTRAINT "TyreReading_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TyreReading" ADD CONSTRAINT "TyreReading_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

