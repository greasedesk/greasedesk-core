-- Operator management (first real Engine Room function): invite/set-password flow, last-login,
-- and SuperAdminAudit extended for operator targets.

-- Operator: set-password invite columns + last login
ALTER TABLE "Operator" ADD COLUMN "invite_token_hash" TEXT;
ALTER TABLE "Operator" ADD COLUMN "invite_token_expires" TIMESTAMP(3);
ALTER TABLE "Operator" ADD COLUMN "invite_token_used_at" TIMESTAMP(3);
ALTER TABLE "Operator" ADD COLUMN "last_login_at" TIMESTAMP(3);

-- SuperAdminAudit: was tenant-target only; make group nullable + add operator-target + reason
ALTER TABLE "SuperAdminAudit" ALTER COLUMN "target_group_id" DROP NOT NULL;
ALTER TABLE "SuperAdminAudit" ADD COLUMN "target_operator_id" TEXT;
ALTER TABLE "SuperAdminAudit" ADD COLUMN "reason" TEXT;
CREATE INDEX "SuperAdminAudit_target_operator_id_idx" ON "SuperAdminAudit"("target_operator_id");
