-- Roster 4b-i. ADDITIVE.
-- closure: company-mandated-closure leave rows (consume allowance AND drop capacity).
ALTER TYPE "LeaveType" ADD VALUE 'closure';
-- Employment dates: recorded only in v1 (anchor for banked pro-rata / leaver / proration).
ALTER TABLE "CostPerson" ADD COLUMN "start_date" TIMESTAMP(3);
ALTER TABLE "CostPerson" ADD COLUMN "end_date" TIMESTAMP(3);
