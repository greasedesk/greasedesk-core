-- Split the two meanings of is_active=false: "invited, never accepted" vs "deactivated by an admin".
-- Additive and nullable. No backfill is needed or possible-to-get-wrong: at the time of writing
-- ZERO users have is_active=false, so there is no existing ambiguous row to classify.
ALTER TABLE "User" ADD COLUMN "deactivated_at" TIMESTAMP(3);
