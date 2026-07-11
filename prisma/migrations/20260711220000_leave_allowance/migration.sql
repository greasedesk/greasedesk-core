-- Annual leave allowance (days, per person). ADDITIVE. Default 28.0 fills existing rows
-- (UK statutory minimum incl. bank holidays for a 5-day week — admin-editable per person).
ALTER TABLE "CostPerson" ADD COLUMN "annual_leave_allowance_days" DECIMAL(4,1) DEFAULT 28.0;
