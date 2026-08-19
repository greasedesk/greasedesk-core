-- OBSERVATION KEY. Additive: one nullable column, one partial unique index, one lookup index.
--
-- Machine-written findings used to locate their own open item by DESCRIPTION PREFIX
-- (startsWith 'Battery', startsWith 'Front left'). That matches hand-typed findings too, so a
-- mechanic's "Battery terminals corroded" would be silently REWRITTEN into a battery advisory by
-- the next test. No error, no trace — the finding just becomes something else.
--
-- NULL means A HUMAN TYPED THIS, which is a distinction worth keeping rather than a gap.

ALTER TABLE "VehicleDueItem" ADD COLUMN "observation_key" TEXT;

-- ONE OPEN ITEM PER OBSERVATION PER CAR, as a CONSTRAINT rather than a convention the writers
-- happen to follow. Partial on both counts: closed items are history and may repeat, and free-text
-- findings (key NULL) are deliberately unconstrained — a car can need two different things nobody
-- had a word for. A future writer that forgets to update-in-place now fails loudly.
CREATE UNIQUE INDEX "VehicleDueItem_open_observation_key"
  ON "VehicleDueItem"("group_id", "vehicle_id", "observation_key")
  WHERE "closed_at" IS NULL AND "observation_key" IS NOT NULL;

-- The writers' find-my-own-item read.
CREATE INDEX "VehicleDueItem_group_id_vehicle_id_observation_key_idx"
  ON "VehicleDueItem"("group_id", "vehicle_id", "observation_key");
