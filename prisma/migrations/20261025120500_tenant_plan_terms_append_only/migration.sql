-- @migration: constraining it drops a UNIQUE index and a NOT NULL column, and backfills a new one
-- @precedes-deploy: nothing deployed reads or writes TenantPlanTerms — the table was created on 2026-10-24 and no feature code has landed — so there is no deployed writer to break; the deploy that follows adds the first writer, and it assumes the append-only shape
--
-- TERMS ARE A TIMELINE, NOT A ROW.
--
-- The table was created with `group_id @unique`: one row per garage, "what they signed up under".
-- That cannot hold. A garage's terms change at least twice over its life — it signs up monthly
-- with a trial, may choose annual at checkout, and a renewal uses the renewal setting in force AT
-- RENEWAL (owner, 2026-10-24). With one row the choice is between overwriting it, which makes
-- "frozen" untrue, and never updating it, which makes "their current plan" unanswerable. The
-- Engine Room needs both questions answered, so the row becomes a timeline:
--
--   what they signed up under  = the EARLIEST row for the garage
--   what they are on now       = the LATEST row for the garage
--
-- Same discipline as CommissionRate: append forward, never edit history.
ALTER TABLE "TenantPlanTerms" ADD COLUMN "effective_from" TIMESTAMP(3);

-- THE BACKFILLED ROWS BECOME EACH GARAGE'S FIRST ENTRY (owner's words). Their signed_up_at IS the
-- moment those terms took effect, so the copy is exact and invents nothing.
UPDATE "TenantPlanTerms" SET "effective_from" = "signed_up_at" WHERE "effective_from" IS NULL;
ALTER TABLE "TenantPlanTerms" ALTER COLUMN "effective_from" SET NOT NULL;

DROP INDEX "TenantPlanTerms_group_id_key";
CREATE INDEX "TenantPlanTerms_group_id_effective_from_idx" ON "TenantPlanTerms"("group_id", "effective_from");

-- ── DROPPING signed_up_at IS LOSSLESS, AND KEEPING IT WOULD NOT BE HARMLESS ───────────────────
-- Every value is preserved in effective_from by the UPDATE above, and the garage's signup date is
-- independently on Group.created_at. Kept, it would have to be written on EVERY future row — the
-- same fact repeated down a timeline, which is the shape that drifts. Nothing reads this column:
-- the table has no readers at all yet.
ALTER TABLE "TenantPlanTerms" DROP COLUMN "signed_up_at";
