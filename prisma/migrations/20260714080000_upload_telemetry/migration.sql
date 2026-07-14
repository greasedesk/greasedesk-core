-- Upload failure telemetry (2026-07-14): technical black-box, separate from the business audit trail.
CREATE TABLE "UploadTelemetry" (
  "id" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "job_card_id" TEXT NOT NULL,
  "photo_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "step" TEXT NOT NULL,
  "status" INTEGER NOT NULL DEFAULT 0,
  "code" TEXT,
  "body" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UploadTelemetry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UploadTelemetry_job_card_id_created_at_idx" ON "UploadTelemetry"("job_card_id", "created_at");
CREATE INDEX "UploadTelemetry_group_id_created_at_idx" ON "UploadTelemetry"("group_id", "created_at");
