-- WHICH CONVENTION THE SCREEN WAS SHOWING when a garage transcribed a service computer.
--
-- `countdown_miles` already records what was typed, but a NULL there cannot distinguish "the garage
-- typed an absolute target" from "this row predates the column". Every mileage-bearing row today is
-- the second: 0 of 88 VehicleDueItem rows and 0 of 47 ServiceScheduleReading rows have ever carried
-- a countdown, and all 47 mileage targets sit behind their car's odometer, reading as intervals
-- typed into a target-mode box.
--
-- NULLABLE AND NOT BACKFILLED, deliberately. NULL means "not written by the schedule form", which is
-- the truth for every existing row and will remain the truth for the writers that cannot answer the
-- question: the hand-typed findings form has no countdown notion, and a tyre-derived target is a
-- wear projection nobody transcribed. Backfilling `unknown` would write a value where absence
-- already says it, and would be indistinguishable from a garage that actively chose it.
--
-- Written ONLY by pages/api/service-schedule, from what the SERVER resolved. Nothing reads it yet.
CREATE TYPE "ScheduleReadingMode" AS ENUM ('target', 'countdown', 'unknown');

ALTER TABLE "ServiceScheduleReading" ADD COLUMN "mode" "ScheduleReadingMode";
ALTER TABLE "VehicleDueItem" ADD COLUMN "mode" "ScheduleReadingMode";
