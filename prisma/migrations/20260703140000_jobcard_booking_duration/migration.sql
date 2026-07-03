-- Occupancy-footprint Stage 1: working-duration as the booking source of truth. Additive, nullable —
-- existing rows stay NULL and the consumers fall back to (end_at - start_at) until the Stage 2 backfill
-- populates this and re-derives end_at as the footprint's true wrapped end. No data touched here.
ALTER TABLE "JobCard" ADD COLUMN "booking_duration_minutes" INTEGER;
