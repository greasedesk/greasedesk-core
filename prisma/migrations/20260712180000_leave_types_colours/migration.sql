-- 4d: three more leave types (capacity-affecting, allowance-neutral — see lib/leave-types
-- DEDUCTS_ALLOWANCE) + per-tenant leave-type colour overrides. ADDITIVE.
ALTER TYPE "LeaveType" ADD VALUE 'compassionate';
ALTER TYPE "LeaveType" ADD VALUE 'parental';
ALTER TYPE "LeaveType" ADD VALUE 'training';
ALTER TABLE "Group" ADD COLUMN "leave_type_colours" JSONB;
