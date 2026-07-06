-- Video walkaround: media discriminator + duration on JobCardPhoto. Additive nullable;
-- existing rows stay NULL (interpreted as photo) — no destructive backfill.
ALTER TABLE "JobCardPhoto" ADD COLUMN "media_type" TEXT;
ALTER TABLE "JobCardPhoto" ADD COLUMN "duration_seconds" INTEGER;
