-- Additive/non-destructive: internal notes + "held on lift" flag on the job card.
-- Booking storage (resource_id/start_at/end_at) already exists — no change.
ALTER TABLE "JobCard" ADD COLUMN "garage_notes" TEXT;
ALTER TABLE "JobCard" ADD COLUMN "held_on_lift" BOOLEAN NOT NULL DEFAULT false;
