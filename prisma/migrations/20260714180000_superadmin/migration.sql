-- SuperAdmin operator portal (v0): allowlist, platform audit, tenant soft-delete.
ALTER TABLE "Group" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE TABLE "PlatformOperator" (
  "user_id" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformOperator_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "SuperAdminAudit" (
  "id" TEXT NOT NULL,
  "operator_user_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_group_id" TEXT NOT NULL,
  "target_name_snapshot" TEXT NOT NULL,
  "target_ref_snapshot" TEXT,
  "detail" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SuperAdminAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SuperAdminAudit_created_at_idx" ON "SuperAdminAudit"("created_at");
CREATE INDEX "SuperAdminAudit_target_group_id_idx" ON "SuperAdminAudit"("target_group_id");
