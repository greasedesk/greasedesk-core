-- Duplicate-estimate provenance: which card this one was copied from (SetNull survives source
-- hard-delete) + the inherited-costs advisory flag (cleared by the first estimate save).
ALTER TABLE "JobCard" ADD COLUMN "duplicated_from_id" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "costs_inherited" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_duplicated_from_id_fkey" FOREIGN KEY ("duplicated_from_id") REFERENCES "JobCard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "JobCard_duplicated_from_id_idx" ON "JobCard"("duplicated_from_id");
