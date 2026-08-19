-- WHAT A GARAGE HAS DONE ABOUT A CAR THAT IS DUE. Additive: two enums, one table.
--
-- A LIST WITHOUT THIS IS A REPORT, and a badge over a report only ever grows. The Messages badge
-- taught this once already: it counted open conversations while nothing could arrive, so it could
-- only read zero — "a badge showing 0 is noise pretending to be information" (AdminLayout). The
-- inverse is worse: a badge that never falls is one a garage stops seeing within a week.
--
-- ONE ROW PER (vehicle, reason), updated in place. The history lives in AuditLog, which is where
-- history lives; this table answers one question — what is outstanding right now.

CREATE TYPE "MarketingReason" AS ENUM ('mot', 'service');
CREATE TYPE "MarketingState" AS ENUM ('contacted', 'booked', 'declined', 'snoozed');

CREATE TABLE "MarketingContact" (
    "id"           TEXT NOT NULL,
    "group_id"     TEXT NOT NULL,
    "vehicle_id"   TEXT NOT NULL,
    "reason"       "MarketingReason" NOT NULL,
    "state"        "MarketingState" NOT NULL,

    -- THE TRIGGER THIS WAS ABOUT. An MOT due 1 September, or a service projected to it. The record
    -- is SPENT once that date passes: if the car is still due on the 2nd, it needs contacting
    -- again, and if the MOT was actually done the new expiry is a year out and the car has left the
    -- window anyway. One comparison, and it self-corrects — which also softens `booked` trusting
    -- the tap, because a booking that never happened resurfaces the day after the date it claimed.
    "for_date"     TIMESTAMP(3) NOT NULL,

    -- Explicit snooze. NULL unless state = 'snoozed'. A snooze with no end is a hide, so the writer
    -- always sets one.
    "snooze_until" TIMESTAMP(3),

    "actor_id"     TEXT,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingContact_pkey" PRIMARY KEY ("id")
);

-- A snooze without an end is the bug this refuses. Every other state leaves it null.
ALTER TABLE "MarketingContact"
  ADD CONSTRAINT "MarketingContact_snooze_paired"
  CHECK (("state" = 'snoozed') = ("snooze_until" IS NOT NULL));

CREATE UNIQUE INDEX "MarketingContact_group_id_vehicle_id_reason_key"
  ON "MarketingContact"("group_id", "vehicle_id", "reason");
CREATE INDEX "MarketingContact_group_id_reason_for_date_idx"
  ON "MarketingContact"("group_id", "reason", "for_date");

ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingContact" ADD CONSTRAINT "MarketingContact_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
