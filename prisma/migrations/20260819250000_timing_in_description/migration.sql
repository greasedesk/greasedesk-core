-- WHERE THE TIMING LIVES. Additive: one boolean, defaulted false.
--
-- printedDueItemsBlock appends dueLabel() to every description, which produced this on a real
-- customer's invoice: "Battery — 9.00V resting, a cell has failed. Replace. due at the next
-- service". Two answers to one question, and the second one wrong about the car.
--
-- FALSE is the safe default and the common case: a finding says WHAT and the basis says WHEN. TRUE
-- means the description already carries its own timing, so appending a label would contradict it.
ALTER TABLE "VehicleDueItem" ADD COLUMN "timing_in_description" BOOLEAN NOT NULL DEFAULT false;
