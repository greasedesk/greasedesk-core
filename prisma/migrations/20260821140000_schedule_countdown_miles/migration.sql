-- What the service computer actually showed, when it showed a countdown rather than a target.
-- due_mileage stays the derived absolute odometer every reader already understands; this is the
-- measurement it came from, kept because the other input (the car's reading) is editable.
ALTER TABLE "ServiceScheduleReading" ADD COLUMN "countdown_miles" INTEGER;
ALTER TABLE "VehicleDueItem" ADD COLUMN "countdown_miles" INTEGER;
