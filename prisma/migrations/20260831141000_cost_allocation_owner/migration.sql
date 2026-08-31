-- CostAllocation now has a THIRD possible owner, and the CHECK constraint had to be told.
--
-- `CostAllocation_one_owner_chk` enforces exactly one of cost_person_id / overhead_id. Prisma's
-- schema cannot express a CHECK, so `migrate diff` added the cost_id column and left the constraint
-- alone — every allocation to a Cost was refused with 23514. Second time a CHECK has drifted from
-- the code this way (MarketingContact_reason_check was the first), and enum-drift-gate does not
-- cover CHECKs: it compares pg_enum values, which is a different object.
ALTER TABLE "CostAllocation" DROP CONSTRAINT "CostAllocation_one_owner_chk";

-- Exactly ONE owner, still. An allocation belonging to nothing, or to two things at once, is not a
-- half-configured row to be tidied later — it is a cost apportioned to a subject nobody can name.
ALTER TABLE "CostAllocation" ADD CONSTRAINT "CostAllocation_one_owner_chk" CHECK (
  (CASE WHEN cost_person_id IS NOT NULL THEN 1 ELSE 0 END)
+ (CASE WHEN overhead_id    IS NOT NULL THEN 1 ELSE 0 END)
+ (CASE WHEN cost_id        IS NOT NULL THEN 1 ELSE 0 END) = 1
);
