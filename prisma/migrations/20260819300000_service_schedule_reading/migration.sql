-- WHAT THE SERVICE COMPUTER SAID ON ARRIVAL. Additive: one table.
--
-- The computer is read TWICE in a visit and the two readings are different KINDS of fact:
--
--   ON ARRIVAL   what was due when the car came in. A fact about a VISIT — it catches what the
--                customer did not know about and confirms what they booked.
--   ON DEPARTURE what the car needs next, after we reset the indicator and fitted the pads. A fact
--                about a CAR, which is a VehicleDueItem, and the only one the invoice may print.
--
-- Forcing both into one VehicleDueItem row loses the first: the partial unique index gives one open
-- item per key per car, so the departure reading overwrites the arrival one and "60,000 on arrival,
-- 70,000 after" collapses to a single number. That distinction is the difference between a
-- completed sale and a job that walked out of the door.
--
-- job_card_id is NOT NULL and CASCADES, unlike TyreReading's. A tyre depth is about the car and
-- must outlive the card it was captured on; this is about the visit, and without the visit there is
-- no fact to keep.
CREATE TABLE "ServiceScheduleReading" (
    "id"          TEXT NOT NULL,
    "group_id"    TEXT NOT NULL,
    "vehicle_id"  TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "item_key"    TEXT NOT NULL,

    -- The 1st of the month, month precision by construction — a service computer prints "11/2025".
    -- See lib/service-schedule::STORED_DAY_OF_MONTH for why the 1st and not the last.
    "due_month"   TIMESTAMP(3),
    "due_mileage" INTEGER,

    "recorded_by" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceScheduleReading_pkey" PRIMARY KEY ("id")
);

-- A row with neither leg says nothing. Blank rows are simply not written.
ALTER TABLE "ServiceScheduleReading"
  ADD CONSTRAINT "ServiceScheduleReading_has_a_leg"
  CHECK ("due_month" IS NOT NULL OR "due_mileage" IS NOT NULL);

-- One reading per item per visit — re-reading the computer corrects rather than stacks, exactly as
-- (job_card_id, corner) does for a tyre.
CREATE UNIQUE INDEX "ServiceScheduleReading_job_card_id_item_key_key"
  ON "ServiceScheduleReading"("job_card_id", "item_key");
CREATE INDEX "ServiceScheduleReading_group_id_vehicle_id_recorded_at_idx"
  ON "ServiceScheduleReading"("group_id", "vehicle_id", "recorded_at");

ALTER TABLE "ServiceScheduleReading" ADD CONSTRAINT "ServiceScheduleReading_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceScheduleReading" ADD CONSTRAINT "ServiceScheduleReading_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceScheduleReading" ADD CONSTRAINT "ServiceScheduleReading_job_card_id_fkey"
  FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
