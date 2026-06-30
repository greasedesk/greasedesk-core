-- Additive, non-destructive: per-quote VAT rate on the job card (editable, clamped 0–100 in app).
-- Existing rows default to 20.
ALTER TABLE "JobCard" ADD COLUMN "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 20;
