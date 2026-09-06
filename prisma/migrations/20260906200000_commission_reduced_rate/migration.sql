-- The reduced commission rate, paid when a month's visit did not happen.
--
-- ON THE RATE TIMELINE, not a percentage applied at payout: what the reduced rate WAS in March must
-- not move when it changes in April, for the same reason the full amount is dated and frozen.
--
-- NULLABLE, with no default. The three GB/GBP rows that predate 2026-09-06 are NULL because the
-- concept did not exist when they were written — that is true, not unfilled. A payout meeting a
-- NULL must refuse rather than invent a figure. A default of zero would be a decision, and an
-- undecided rate is not one.
ALTER TABLE "CommissionRate" ADD COLUMN "amount_unvisited_pennies" INTEGER;
