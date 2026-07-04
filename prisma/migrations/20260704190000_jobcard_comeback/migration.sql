-- Warranty/comeback flag on the job card (real cost, zero revenue for reporting). Additive.
ALTER TABLE "JobCard" ADD COLUMN "is_comeback" BOOLEAN NOT NULL DEFAULT false;
