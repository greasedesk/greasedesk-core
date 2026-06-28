-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "end_at" TIMESTAMP(3),
ADD COLUMN     "start_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobCard_resource_id_start_at_idx" ON "JobCard"("resource_id", "start_at");
