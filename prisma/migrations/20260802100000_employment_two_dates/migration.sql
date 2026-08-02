-- Two dates at each end of employment. ADDITIVE ONLY, deliberately: `end_date` is NOT renamed,
-- because `prisma migrate deploy` runs during the Vercel build while the PREVIOUS deployment is
-- still serving — a rename would make the live dashboard, roster and HR pages throw for the
-- minutes until the new build is promoted. Nothing reads end_date after this deploy; it is
-- all-null across every tenant (censused) and drops in a follow-up migration.
ALTER TABLE "CostPerson" ADD COLUMN "work_end_date" TIMESTAMP(3);
ALTER TABLE "CostPerson" ADD COLUMN "pay_end_date" TIMESTAMP(3);
ALTER TABLE "CostPerson" ADD COLUMN "pay_start_date" TIMESTAMP(3);
-- Carry anything already recorded onto the new column. Zero rows today; correct if that changes
-- between writing this and it running.
UPDATE "CostPerson" SET "work_end_date" = "end_date" WHERE "end_date" IS NOT NULL;
