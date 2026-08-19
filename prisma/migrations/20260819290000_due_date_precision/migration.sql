-- WHAT THE DATE ACTUALLY KNOWS. Additive: one enum, one defaulted column.
--
-- A service computer says "Oil service due 11/2025" and "Brake fluid change due 01/2025". There is
-- no day in that, and a dd/mm/yyyy input forces one nobody has. due_date is a DateTime, so SOMETHING
-- has to be stored — the 1st — and this column records that the day was never meant, so no renderer
-- shows it. Without it the convention lives only in a comment, and the reader that matters is
-- dueLabel, which cannot read comments: it would print "due by 1 November 2026", a day we invented,
-- on a frozen invoice a customer keeps.
--
-- DEFAULT `day` is correct for everything already stored: the findings form uses a date picker, so
-- those dates are genuine. One row in the database has a date basis and it is a real day.
CREATE TYPE "DueDatePrecision" AS ENUM ('day', 'month');

ALTER TABLE "VehicleDueItem"
  ADD COLUMN "due_date_precision" "DueDatePrecision" NOT NULL DEFAULT 'day';
