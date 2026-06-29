-- Hand-written: sequence-driven ref + tenant status/trial fields (additive).
CREATE SEQUENCE "group_ref_seq" START WITH 1965;

CREATE TYPE "TenantStatus" AS ENUM ('trial', 'active', 'suspended', 'cancelled');
ALTER TABLE "Group" ADD COLUMN "status" "TenantStatus" NOT NULL DEFAULT 'trial';

ALTER TABLE "Group" ADD COLUMN "trial_ends_at" TIMESTAMP(3);

-- ref nullable here so the backfill can assign existing rows in created_at order;
-- made NOT NULL + sequence-default in the backfill migration.
ALTER TABLE "Group" ADD COLUMN "ref" TEXT;
CREATE UNIQUE INDEX "Group_ref_key" ON "Group"("ref");
