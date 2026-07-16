-- Setup-checklist applicability declarations (item-13). NOT "done" flags — completion stays derived
-- from real rows. These let a sole trader mark employees / company number "not applicable".
ALTER TABLE "Group" ADD COLUMN "employees_not_applicable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Group" ADD COLUMN "company_number_not_applicable" BOOLEAN NOT NULL DEFAULT false;
