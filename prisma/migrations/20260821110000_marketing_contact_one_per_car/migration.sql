-- ONE ANSWER PER CAR, because a garage makes one phone call about a car.
--
-- The key was (group, vehicle, reason) from when the board was two lists — an MOT tab and a
-- servicing tab — and a car could legitimately be pursued twice for two different things. The board
-- is now one row per car carrying every reason it is worth ringing about, so that key would let a
-- car be contacted under `mot` and not-contacted under `service` at the same time: one phone call,
-- two records, and a list that disagrees with itself about whether the call happened.
--
-- Worse, `reason` had already stopped being true. The board passes a hardcoded 'mot' for every row,
-- so a car rung about a failed battery recorded a contact saying the call was about its MOT. A
-- column nobody notices is wrong until they read the history back six months later.
--
-- SAFE BY TIMING, NOT BY LUCK: MarketingContact holds ZERO rows across every tenant at the moment
-- this runs (checked 21 Aug 2026). This is a decision, not a repair — and it stops being free the
-- first time somebody rings a customer.
DROP INDEX IF EXISTS "MarketingContact_group_id_vehicle_id_reason_key";
CREATE UNIQUE INDEX "MarketingContact_group_id_vehicle_id_key"
  ON "MarketingContact" ("group_id", "vehicle_id");

-- `reason` stays, as a RECORD of what the call was about rather than part of the identity. It is
-- now free to say what is true — the lead's own strongest reason, not a list name.
DROP INDEX IF EXISTS "MarketingContact_group_id_reason_for_date_idx";
CREATE INDEX "MarketingContact_group_id_for_date_idx" ON "MarketingContact" ("group_id", "for_date");
