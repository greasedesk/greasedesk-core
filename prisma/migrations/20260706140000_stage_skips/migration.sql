-- Soft photo-stage gates: skipped flags (complete OR skipped advances the spine). Additive,
-- default false — existing cards (June = quoted) are untouched and land exactly where they were.
ALTER TABLE "JobCard" ADD COLUMN "stage_intake_skipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobCard" ADD COLUMN "stage_injob_skipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobCard" ADD COLUMN "stage_complete_skipped" BOOLEAN NOT NULL DEFAULT false;
