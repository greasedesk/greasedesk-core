-- Per-person utilisation factor (workshop expectation, NEVER an individual score). ADDITIVE.
-- NOT NULL default 70 fills existing rows — the system never holds a null factor.
ALTER TABLE "CostPerson" ADD COLUMN "utilisation_factor" INTEGER NOT NULL DEFAULT 70;
ALTER TYPE "EmploymentEventKind" ADD VALUE 'factor';
