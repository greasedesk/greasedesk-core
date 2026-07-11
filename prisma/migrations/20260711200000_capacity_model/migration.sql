-- Capacity model (utilisation denominator). All ADDITIVE.

-- CostPerson: chargeable flag + contracted hours + rostered-weekday pattern
-- (empty array = inherit the site's open_days).
ALTER TABLE "CostPerson" ADD COLUMN "is_chargeable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CostPerson" ADD COLUMN "contracted_hours_per_day" DECIMAL(4,2);
ALTER TABLE "CostPerson" ADD COLUMN "working_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

CREATE TYPE "LeaveType" AS ENUM ('annual', 'sick', 'other');
CREATE TYPE "LeaveStatus" AS ENUM ('approved');

CREATE TABLE "LeaveRecord" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "cost_person_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "hours" DECIMAL(4,2),
    "type" "LeaveType" NOT NULL DEFAULT 'annual',
    "status" "LeaveStatus" NOT NULL DEFAULT 'approved',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeaveRecord_cost_person_id_date_key" ON "LeaveRecord"("cost_person_id", "date");
CREATE INDEX "LeaveRecord_group_id_site_id_date_idx" ON "LeaveRecord"("group_id", "site_id", "date");
ALTER TABLE "LeaveRecord" ADD CONSTRAINT "LeaveRecord_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRecord" ADD CONSTRAINT "LeaveRecord_cost_person_id_fkey" FOREIGN KEY ("cost_person_id") REFERENCES "CostPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRecord" ADD CONSTRAINT "LeaveRecord_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PublicHoliday" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "site_id" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublicHoliday_group_id_site_id_date_key" ON "PublicHoliday"("group_id", "site_id", "date");
CREATE INDEX "PublicHoliday_group_id_date_idx" ON "PublicHoliday"("group_id", "date");
ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicHoliday" ADD CONSTRAINT "PublicHoliday_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
