-- HR history hardening. ADDITIVE.
-- name/role become recorded history (a surname change and a role step-up are HR facts).
ALTER TYPE "EmploymentEventKind" ADD VALUE 'name';
ALTER TYPE "EmploymentEventKind" ADD VALUE 'role';
-- Corrections: append-only must not mean mistakes are permanent. A redate updates
-- effective_date IN PLACE and appends {at, by, from, to} into correction_json (the correction is
-- itself recorded); a void keeps the row visible but excluded from any value-at-time read.
ALTER TABLE "EmploymentEvent" ADD COLUMN "correction_json" JSONB;
ALTER TABLE "EmploymentEvent" ADD COLUMN "voided_at" TIMESTAMP(3);
ALTER TABLE "EmploymentEvent" ADD COLUMN "voided_by" TEXT;
