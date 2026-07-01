-- Cost-capture foundation: headcount + overheads with per-site allocation.
-- Additive only: two enums, three new tables. No change to any existing table.

-- Enums
CREATE TYPE "CostType"       AS ENUM ('salary', 'hourly');
CREATE TYPE "OverheadPeriod" AS ENUM ('weekly', 'monthly', 'annual');

-- Headcount (people-as-costs; independent of User)
CREATE TABLE "CostPerson" (
  "id"             TEXT NOT NULL,
  "group_id"       TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "role"           TEXT,
  "cost_type"      "CostType" NOT NULL,
  "amount_pennies" INTEGER NOT NULL,
  "user_id"        TEXT,
  "is_active"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostPerson_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CostPerson_user_id_key" ON "CostPerson"("user_id");
CREATE INDEX "CostPerson_group_id_idx" ON "CostPerson"("group_id");
ALTER TABLE "CostPerson" ADD CONSTRAINT "CostPerson_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostPerson" ADD CONSTRAINT "CostPerson_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Overheads (open-ended, admin-extendable)
CREATE TABLE "Overhead" (
  "id"             TEXT NOT NULL,
  "group_id"       TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "amount_pennies" INTEGER NOT NULL,
  "period"         "OverheadPeriod" NOT NULL,
  "is_active"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Overhead_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Overhead_group_id_idx" ON "Overhead"("group_id");
ALTER TABLE "Overhead" ADD CONSTRAINT "Overhead_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shared allocation mechanism (one cost -> many site allocations)
CREATE TABLE "CostAllocation" (
  "id"             TEXT NOT NULL,
  "group_id"       TEXT NOT NULL,
  "site_id"        TEXT NOT NULL,
  "percent"        DECIMAL(5,2) NOT NULL,
  "cost_person_id" TEXT,
  "overhead_id"    TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostAllocation_pkey" PRIMARY KEY ("id"),
  -- exactly one owner (person XOR overhead)
  CONSTRAINT "CostAllocation_one_owner_chk" CHECK (
    ("cost_person_id" IS NOT NULL AND "overhead_id" IS NULL) OR
    ("cost_person_id" IS NULL AND "overhead_id" IS NOT NULL)
  ),
  CONSTRAINT "CostAllocation_percent_chk" CHECK ("percent" > 0 AND "percent" <= 100)
);
CREATE INDEX "CostAllocation_group_id_idx"       ON "CostAllocation"("group_id");
CREATE INDEX "CostAllocation_site_id_idx"        ON "CostAllocation"("site_id");
CREATE INDEX "CostAllocation_cost_person_id_idx" ON "CostAllocation"("cost_person_id");
CREATE INDEX "CostAllocation_overhead_id_idx"    ON "CostAllocation"("overhead_id");
-- one row per (cost, site); NULLs distinct so each partial index only bites its own kind
CREATE UNIQUE INDEX "CostAllocation_cost_person_id_site_id_key" ON "CostAllocation"("cost_person_id", "site_id");
CREATE UNIQUE INDEX "CostAllocation_overhead_id_site_id_key"    ON "CostAllocation"("overhead_id", "site_id");
ALTER TABLE "CostAllocation" ADD CONSTRAINT "CostAllocation_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostAllocation" ADD CONSTRAINT "CostAllocation_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostAllocation" ADD CONSTRAINT "CostAllocation_cost_person_id_fkey"
  FOREIGN KEY ("cost_person_id") REFERENCES "CostPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostAllocation" ADD CONSTRAINT "CostAllocation_overhead_id_fkey"
  FOREIGN KEY ("overhead_id") REFERENCES "Overhead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
