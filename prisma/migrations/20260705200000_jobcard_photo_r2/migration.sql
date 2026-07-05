-- R2-backed job-card photos: tenant partition + stage/slot/label + object key. Additive; file_url
-- relaxed to nullable (we store the R2 key and presign URLs on demand). 0 real rows today.
ALTER TABLE "JobCardPhoto" ADD COLUMN "group_id" TEXT;
ALTER TABLE "JobCardPhoto" ADD COLUMN "stage" TEXT;
ALTER TABLE "JobCardPhoto" ADD COLUMN "slot" TEXT;
ALTER TABLE "JobCardPhoto" ADD COLUMN "label" TEXT;
ALTER TABLE "JobCardPhoto" ADD COLUMN "r2_key" TEXT;
ALTER TABLE "JobCardPhoto" ALTER COLUMN "file_url" DROP NOT NULL;

CREATE INDEX "JobCardPhoto_job_card_id_stage_idx" ON "JobCardPhoto"("job_card_id", "stage");
