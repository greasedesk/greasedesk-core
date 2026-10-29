-- @migration: additive
--
-- WHEN THIS GARAGE FIRST PAID US A NON-ZERO INVOICE (owner ruling, 2026-10-29).
--
-- The affiliate offer asked "is this a new garage?" and answered it with "has a subscription ever
-- reached trialing". That made the answer depend on a BUTTON rather than on money: a referred
-- garage that chose monthly at signup and switched to yearly during its trial was quoted £750,
-- while the identical garage that left the toggle on yearly paid £450. The ruling is that the
-- offer survives a switch during the trial, which needs the real question answered — have we
-- ever been paid? — and nothing recorded that.
--
-- NULLABLE AND UNWRITTEN BY ANYTHING DEPLOYED, so this is safe to apply whenever. No backfill:
-- the column records what it saw, and the code reads the subscription status alongside it for
-- the garages that paid before the column existed. A backfill would have to invent the dates.

ALTER TABLE "GroupBilling" ADD COLUMN "first_paid_at" TIMESTAMP(3);
