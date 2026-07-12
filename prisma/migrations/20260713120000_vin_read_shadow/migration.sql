-- OCR shadow run (fortnight trial): logs engine attempts on vin-slot photos. No UI reads it.
CREATE TABLE "VinReadShadow" (
  "id" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "photo_id" TEXT NOT NULL,
  "job_card_id" TEXT NOT NULL,
  "engine" TEXT NOT NULL,
  "candidates" JSONB,
  "checksum_valid" BOOLEAN NOT NULL DEFAULT false,
  "latency_ms" INTEGER NOT NULL DEFAULT 0,
  "cost_microdollars" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VinReadShadow_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VinReadShadow_photo_id_idx" ON "VinReadShadow"("photo_id");
CREATE INDEX "VinReadShadow_group_id_created_at_idx" ON "VinReadShadow"("group_id", "created_at");
