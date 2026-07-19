-- Diary duration for an imported card. Was hardcoded to 60 minutes at commit, so every imported
-- job occupied exactly one hour regardless of the work done. Staging only; additive.
ALTER TABLE "StagedInvoice" ADD COLUMN "planned_working_minutes" INTEGER;
