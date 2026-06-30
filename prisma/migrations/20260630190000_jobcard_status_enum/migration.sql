-- Hand-written: convert JobCard.status from free-form text to a proper enum.
-- Additive/non-destructive: existing 'open' rows map to 'draft' (the entry state); default → 'draft'.
CREATE TYPE "JobCardStatus" AS ENUM (
  'draft','quoted','accepted','declined','in_progress','invoiced','paid','done','cancelled'
);
ALTER TABLE "JobCard" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "JobCard" ALTER COLUMN "status" TYPE "JobCardStatus"
  USING (CASE "status" WHEN 'open' THEN 'draft'::"JobCardStatus" ELSE 'draft'::"JobCardStatus" END);
ALTER TABLE "JobCard" ALTER COLUMN "status" SET DEFAULT 'draft';
