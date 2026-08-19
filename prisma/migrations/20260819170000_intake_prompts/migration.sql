-- Intake prompts: four per-site switches (default OFF, prompts not gates) and the
-- "checked, nothing found" affirmative on the job card. Additive only.

-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "intake_nothing_found_at" TIMESTAMP(3),
ADD COLUMN     "intake_nothing_found_by" TEXT;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "intake_prompt_diag_scan" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "intake_prompt_findings" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "intake_prompt_mileage_vin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "intake_prompt_walkaround" BOOLEAN NOT NULL DEFAULT false;

