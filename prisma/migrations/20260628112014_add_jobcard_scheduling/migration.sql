-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "end_slot" INTEGER,
ADD COLUMN     "resource_id" TEXT,
ADD COLUMN     "scheduled_date" DATE,
ADD COLUMN     "start_slot" INTEGER;

-- CreateIndex
CREATE INDEX "JobCard_resource_id_scheduled_date_idx" ON "JobCard"("resource_id", "scheduled_date");

-- AddForeignKey
ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
