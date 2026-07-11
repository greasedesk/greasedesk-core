-- HR effective-dated employment history (record-first). ADDITIVE.
CREATE TYPE "EmploymentEventKind" AS ENUM ('wage', 'hours', 'pattern', 'chargeable', 'allowance', 'started', 'ended');

CREATE TABLE "EmploymentEvent" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "cost_person_id" TEXT NOT NULL,
    "kind" "EmploymentEventKind" NOT NULL,
    "effective_date" TIMESTAMP(3) NOT NULL,
    "value_json" JSONB NOT NULL,
    "previous_json" JSONB,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmploymentEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmploymentEvent_cost_person_id_kind_effective_date_idx" ON "EmploymentEvent"("cost_person_id", "kind", "effective_date");
CREATE INDEX "EmploymentEvent_group_id_created_at_idx" ON "EmploymentEvent"("group_id", "created_at");
ALTER TABLE "EmploymentEvent" ADD CONSTRAINT "EmploymentEvent_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmploymentEvent" ADD CONSTRAINT "EmploymentEvent_cost_person_id_fkey" FOREIGN KEY ("cost_person_id") REFERENCES "CostPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE;
